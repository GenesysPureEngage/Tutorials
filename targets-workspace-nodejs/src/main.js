const workspace = require('genesys-workspace-client-js');
const auth = require('genesys-authorization-client-js');
const url = require('url');
const Promise = require('promise');
const cometDLib = require('cometd');
require('cometd-nodejs-client').adapt();

//Usage: <apiKey> <clientId> <clientSecret> <apiUrl> <agentUsername> <agentPassword> <searchTerm>
const argv = process.argv.slice(2);
const apiKey = argv[0];
const clientId = argv[1];
const clientSecret = argv[2];
const apiUrl = argv[3];
const username = argv[4];
const password = argv[5];
const searchTerm = argv[6];

const workspaceUrl = `${apiUrl}/workspace/v3`;
const authUrl = `${apiUrl}`;

async function main() {
	
	//region Initialize API Client
	//Create and setup ApiClient instance with your ApiKey and Workspace API URL.
	const workspaceClient = new workspace.ApiClient();
	workspaceClient.basePath = workspaceUrl;
	workspaceClient.defaultHeaders = { 'x-api-key': apiKey };
	workspaceClient.enableCookies = true;

	const authClient = new auth.ApiClient();
	authClient.basePath = authUrl;
	authClient.defaultHeaders = { 'x-api-key': apiKey };

	//region Create SessionApi, VoiceApi and TargetsApi instances
	//Creating instances of SessionApi, VoiceApi and TargetsApi using the ApiClient.
	const sessionApi = new workspace.SessionApi(workspaceClient);
	const voiceApi = new workspace.VoiceApi(workspaceClient);
	const targetsApi = new workspace.TargetsApi(workspaceClient);

	//region Create AuthenticationApi instance
	//Create instance of AuthenticationApi using the authorization ApiClient which will be used to retrieve access token.
	const authApi = new auth.AuthenticationApi(authClient); 
	
	let cometD;
	let loggedIn = false;
	
	try {
		//region Oauth2 Authentication
		//Performing Oauth 2.0 authentication.
		console.log("Retrieving access token...");
		const authorization = "Basic " + new String(new Buffer(clientId + ":" + clientSecret).toString("base64"));
		
		let resp = await authApi.retrieveToken("password", "openid", {
			clientId: clientId,
			username: username,
			password: password,
			authorization: authorization
		});
		
		if(!resp["access_token"]) {
			console.error("No access token");
		
		} else {
		
			console.log("Retrieved access token");
			console.log("Initializing workspace...");
	
			resp = await sessionApi.initializeWorkspaceWithHttpInfo({"authorization": "Bearer " + resp["access_token"]});
			
			//region Getting Session ID
			//If the initialize-workspace call is successful, the it will return the workspace session ID as a cookie.
			//We still must wait for 'InitializeWorkspaceComplete' cometD event in order to get user data for the user we are loggin in.
			if(resp.data.status.code == 1) {
				const sessionCookie = resp.response.header["set-cookie"].find(v => v.startsWith("WORKSPACE_SESSIONID"));
				workspaceClient.defaultHeaders["Cookie"] = sessionCookie;
				console.log("Got workspace session id");
				loggedIn = true;
				//region CometD
				//Now that we have our workspace session ID we can start cometD and get initialization event.
				cometD = await startCometD(workspaceUrl, apiKey, sessionCookie);
				
				const user = await waitForInitializeWorkspaceComplete(cometD);
				
				await startHandlingVoiceEvents(cometD, sessionApi, voiceApi, targetsApi);
				//region Activating Channels
				//Once we have subscribed to voice events we can activate channels.
				
				console.log("Activating channels...");
				await sessionApi.activateChannels({
					data: {
						agentId: user.employeeId,
						dn: user.agentLogin
					}
				});
				//endregion
				
			} else {
				console.error("Error initializing workspace");
				console.error("Code: " + resp.data.status.code);
			}
			
		}
		
	} catch(err) {
		if(err.response) console.log(err.response.text);
		else console.log(err);
		
		if(loggedIn) {
			await disconnectAndLogout(cometD, sessionApi);
		}
	}
}

function startCometD(workspaceUrl, apiKey, sessionCookie) {
	return new Promise((resolve, reject) => {
		//region Setting up CometD
		//Setting up cometD making sure api key and session cookie are included in requests.
		const cometD = new cometDLib.CometD();
	
		const hostname = url.parse(workspaceUrl).hostname;
		const transport = cometD.findTransport('long-polling');
		transport.context = {
			cookieStore: {
				[hostname]: [sessionCookie]
			}
		};
	
		cometD.configure({
			url: workspaceUrl + "/notifications",
			requestHeaders: {
				"x-api-key": apiKey,
				"Cookie": sessionCookie
			}
		});
		//region CometD Handshake
		//Perform handshek to start cometD. Once the handshake is successful we can subscribe to channels.
		console.log("CometD Handshake...");
		cometD.handshake((reply) => {
			if(reply.successful) {
				console.log("Handshake successful");
				resolve(cometD);
			
			} else {
				console.error("Handshake unsuccessful");
				reject();
			}
		});
		//endregion
	});
}

function waitForInitializeWorkspaceComplete(cometD) {
	return new Promise((resolve, reject) => {
		console.log("Subscribing to Initilaization channel...");
		//region Subscribe to Initialization Channel
		//Once the handshake is successful we can subscribe to a CometD channels to get events. 
		//Here we subscribe to initialization channel to get 'WorkspaceInitializationComplete' event.
		cometD.subscribe("/workspace/v3/initialization", (message) => {
			if(message.data.state == "Complete") {
				resolve(message.data.data.user);
			}
		}, (reply) => {
			if(reply.successful) {
				console.log("Initialization subscription succesful");
			} else {
				console.error("Subscription unsuccessful");
				reject();
			}
	
		});
	});
}


function startHandlingVoiceEvents(cometD, sessionApi, voiceApi, targetsApi) {
	return new Promise((resolve, reject) => {
		console.log("Subscribing to Voice channel...");
	
		//region Subscribing to Voice Channel
		//Here we subscribe to voice channel so we can handle voice events.
	
		cometD.subscribe("/workspace/v3/voice", makeVoiceEventHandler(cometD, sessionApi, voiceApi, targetsApi) , (reply) => {
			if(reply.successful) {
				console.log("Voice subscription succesful");
				resolve();
			} else {
				console.error("Subscription unsuccessful");
				reject(err);
			}
	
		});
		
		//endregion
	});
}

function makeVoiceEventHandler(cometD, sessionApi, voiceApi, targetsApi) {
	
	
	//region Making Voice Handler
	//Here we handle different CometD messages.
	//In order to specify why certain CometD events are taking place it is necessary to store some information about what has happened.
	var hasActivatedChannels = false;
	var hasCalledInitiateTransfer = false;
	var hasCalledCompleteTransfer = false;
	
	var actionsCompleted = 0;
	
	var consultConnId = null;
	var parentConnId = null;
	
	return async (message) => {
		try {
			if(message.data.messageType == "DnStateChanged") {
				//region Handle Different State changes
				//When the server is done activating channels, it will send a 'DnStateChanged' message with the agent state being 'NotReady'.
				//Once the server is done changing the agent state to 'Ready' we will get another event.
			
				const agentState = message.data.dn.agentState;
			
				if(!hasActivatedChannels) {
					if(agentState == "NotReady" || agentState == "Ready") {
						console.log("Channels activated");
						hasActivatedChannels = true;
					
						console.log("Getting targets...");
					
						const targets = await getTargets(targetsApi, searchTerm);
						
						//region Calling Target
						//Here we print the first10 targets returned from the search and call the first one if it exists.
						if(targets.length == 0) {
							console.error("Search came up empty");
							disconnectAndLogout(cometD, sessionApi);
					
						} else {
						
							console.log("Found targets: " + JSON.stringify(targets));
							console.log("Calling target: " + targets[0].userName);
							
							const phoneNumber = targets[0]["availability"]["channels"][0]["phoneNumber"];
							console.log("Phone number: " + phoneNumber);
							await makeCall(voiceApi, phoneNumber);
							//region Finishing up
							//Now that we have made a call to a target we can disconnect ant logout.
							
							await disconnectAndLogout(cometD, sessionApi);
							console.log("done");
							//endregion
							
						}
					
					}
				}
			}
		} catch(err) {
			if(err.response) console.error(err.response.text);
			else console.error(err);
			
			disconnectAndLogout(cometD, sessionApi);
		}
		
	};
}

async function getTargets(targetsApi, searchTerm, callback) {
	
	//region Get Targets
	//Getting target agents that match the specified search term using the targets api.
	const resp = await targetsApi.get(searchTerm, {
		limit: 10
	});
		
	if(resp.status.code != 0) {
		console.error("Cannot get targets");
		console.error("Code: " + resp.status.code);
		throw "";
	}
	return resp.data.targets;
	//endregion
}

function makeCall(voiceApi, destination, callback) {
	//region Making a Call
	//Using the voice api to make a call to the specified destination.
	return voiceApi.makeCall({
		data: {
			destination: destination
		}
	});
	//endregion
}

async function disconnectAndLogout(cometD, sessionApi) {
	//region Disconnect CometD and Logout Workspace
	//Disconnecting cometD and ending out workspace session.
	if(cometD) {
		await new Promise((resolve, reject) => {
			cometD.disconnect((reply) => {
				if(reply.successful) {
					resolve();
				} else {
					reject();
				}
			});
		});
	}
	
	try {
		await sessionApi.logout();
	} catch(err) {
		console.error("Could not log out");
		process.exit(1);
	}
	//endregion
}

main();