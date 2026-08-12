'use strict'

//-------------

require('dotenv').config();

const express = require('express');
const bodyParser = require('body-parser')
const app = express();
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const moment = require('moment');

//-- CORS - update as needed for your environment -
app.use(function (req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    // res.header("Access-Control-Allow-Methods", "OPTIONS,GET,POST,PUT,DELETE");
    res.header("Access-Control-Allow-Methods", "GET,POST");
    res.header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");
    next();
});

//--

app.use(bodyParser.json());

//------------------------------

const appId = process.env.APP_ID;
const serviceNumber = process.env.SERVICE_NUMBER;

const apiRegion = process.env.API_REGION;
const dc = apiRegion.substring(4, 6);

// just for tests
// const dc = 'us';

console.log(">>>> dc:", dc);

// ------------------

console.log("Service phone number:", serviceNumber);

//-------------------

const { Auth } = require('@vonage/auth');

const credentials = new Auth({
  apiKey: process.env.API_KEY,
  apiSecret: process.env.API_SECRET,
  applicationId: appId,
  privateKey: './.private.key'
});

const { Vonage } = require('@vonage/server-sdk');

const vonage = new Vonage(credentials);

const privateKey = fs.readFileSync('./.private.key');

const { tokenGenerate } = require('@vonage/jwt');

//-- List of allowable client SDK (WebRTC client) users --

const clientList = process.env.CLIENT_SDK_USERS.toLowerCase().split(/\s*,+\s*/);

let clients = new Set();

for (let client in clientList){
  clients.add(clientList[client]);
};

console.log('List of allowable clients:', clients);

const clientsArray = Array.from(clients);

// no IVR for direct in-app to in-app calls (WebRTC client to WebRTC client)

//---- Connector server ----
const connectorServer = process.env.PROCESSOR_SERVER;

//---- Default language code ----
const sttLanguageCode = process.env.STT_LANGUAGE_CODE

//---- Call leg info tracking ----

let callTracking = {}; // dictionary

function addInfoToCallTracking(uuid) {
  callTracking[uuid] = {};
  callTracking[uuid]["confNumber"] = null;  // conference bridge number
  callTracking[uuid]["peerWsUuid"] = null;  // associated WebSocket leg uuid
  callTracking[uuid]["convUuid"] = null;
  // callTracking[uuid]["startTime"] = moment(Date.now()).format('YYYY-MM-DD HH:mm:ss:SSS'); // server local time
  // callTracking[uuid]["startTime"] = moment.utc(Date.now()).format('YYYY-MM-DD HH:mm:ss:SSS'); // UTC time
}

function deleteFromCallTracking(uuid) {
  delete callTracking[uuid];
}

//---- Conference name info tracking ----

let confName = {}; // dictionary

function addInfoToConfName(number) {
  const name = "conf_" + crypto.randomUUID();
  confName[number] = {};
  confName[number]["confName"] = name; // map number to a conference name
  confName[number]["startTime"] = moment(Date.now()).format('YYYY-MM-DD HH:mm:ss:SSS'); // server local time
  // confName[number]["startTime"] = moment.utc(Date.now()).format('YYYY-MM-DD HH:mm:ss:SSS'); // UTC time
  // console.log(`>>> Conference number ${number} mapped to conference name ${name}`);

  setTimeout( () => {
    delete confName[number];
    // console.log(`>>> confName[${number}] dictionary entry deleted`);
  }, 30000);

  return name;
}

//------------------------------


//-- JUST FOR TESTS
//-- Random fixed 6-digit bridge number
//-- (a different one each time you start/restart this application)

const confNumber = String(Math.floor(Math.random() * 1000000)).padStart(6, '0');

console.log('>>> Conference number:', confNumber);

const spokenConfNumber = confNumber.split('').join(' ');

const conferenceName = confName?.[confNumber]?.["confName"] ?? addInfoToConfName(confNumber);
// console.log('>>> ConferenceName:', conferenceName);


//==========================================================

app.get('/answer', (req, res) => {

  addInfoToCallTracking(req.query.uuid);  // create info set for this leg

  const hostName = req.hostname;

  const  nccoResponse = [
    {
      "action": "talk",
    "text": `We are connecting your call to the conference bridge number ${spokenConfNumber}, please wait`,
      "language": "en-US",
      "style": 11
    },
    {
      "action": "conversation",
      "name": conferenceName,
      "startOnEnter": true
    }
  ];  

  res.status(200).json(nccoResponse);

});

//--------

app.post('/event', (req, res) => {

  const uuid = req.body.uuid;

  const hostName = req.hostname;

  if (req.body.type == "transfer") {

    // WebSocket URI to the connector server
    const wsUri = 'wss://' + connectorServer + '/socket?peer_uuid=' + uuid + '&language_code=' + sttLanguageCode + '&webhook_url=https://' + hostName + '/results'; 

    console.log('>>> WebSocket URI:', wsUri);

    // create corresponding websocket
    vonage.voice.createOutboundCall({
      to: [{
        type: 'websocket',
        uri: wsUri,
        'content-type': 'audio/l16;rate=16000',  // NEVER change the content-type parameter argument
        headers: {}
      }],
      from: {
        type: 'phone',
        number: serviceNumber // cannot use a longer than 15-digit string (e.g. not call_uuid)
      },
      answer_url: ['https://' + hostName + '/ws_answer?peer_uuid=' + uuid + '&conference_number=' + '456789'],
      event_method: "GET",
      event_url: ['https://' + hostName + '/ws_event?peer_uuid=' + uuid + '&conference_number=' + '456789'],
      event_method: "POST"
      // ncco: [
      //   {
      //     "action": "conversation",
      //     "name": conferenceName,
      //     "startOnEnter": true,
      //     "canHear": [uuid] // this WebSocket listens only to this very call leg
      //   }
      // ]
    })
      .then(res => {

        callTracking[uuid]["wsUuid"] = res.uuid;  // store peer WebSocet leg uuid for original call info set
        
        addInfoToCallTracking(res.uuid);  // WebSocket uuid
        callTracking[res.uuid]["convUuid"] = res.conversation_uuid; // Initial Conv uuid of this WebSocket leg
        
        console.log(">>> outgoing WebSocket call status:", res);
      })
      .catch(err => console.error(">>> outgoing WebSocket call error:", err));
      
  }

  //--

  if (req.body.status == "completed") {

    // terminate peer WebSocket leg
    const wsUuid = callTracking[uuid]?.["wsUuid"] ?? null;

    // debug
    console.log('>>> wsUuid:', wsUuid);

    if (wsUuid) {
      vonage.voice.hangupCall(wsUuid)
        .then(res => console.log('>>> WebSocket ' + wsUuid + ' terminated'))
        .catch(err => {
          console.error('>>> WebSocket ' + wsUuid + ' tear down error', err)
          // you may see error 400 bad request if this WebSocket leg has already terminated, that's not a problem
        });
    }

    //---

    setTimeout ( () => {

      deleteFromCallTracking(uuid); // info set no longer needed

    }, 5000)

  }

  //----

  res.status(200).send('Ok');
  
});

//--------

app.post('/inappevent', (req, res) => {

  res.status(200).send('Ok');
  
});

//--------

app.get('/ws_answer', (req, res) => {

  const nccoResponse = [
    {
      "action": "conversation",
      "name": conferenceName,
      "startOnEnter": true,
      "canHear": [req.query.peer_uuid] // this WebSocket listens only to the peer call leg
    }
  ];

  res.status(200).json(nccoResponse);
  
});

//--------

app.post('/ws_event', (req, res) => {

  if (req.body.type == "transfer") {  // the WebSocket leg is now effectively attached to the conference

    const peerUuid = req.query.peer_uuid;

    vonage.voice.playTTS(peerUuid,  
    {
      text: 'You may now speak.',
      language: 'en-US', 
      style: 11
    })
    .then(resp => console.log('>>> Play TTS on participant leg', peerUuid))
    .catch(err => console.error('>>> Play TTS error on participant leg', peerUuid, err));

  }  

  //--

  if (req.body.status == "completed") {

    setTimeout ( () => {
      deleteFromCallTracking(req.body.uuid); // info set no longer needed
    }, 5000)

  }  

  res.status(200).send('Ok');
  
});

//--------

app.post('/results', (req, res) => {

  console.log(req.body);

  res.status(200).send('Ok');
  
});

//=== Services for the WebRTC client (Vonage client SDK) ===============

app.post('/login', async (req, res) => {

    const user = req.body.user; // web page should have already made the name to lower case

    // check if user is in the list of allowable users
    if (!clients.has(user)) {
      return res.status(401).json({ name: user, message: ">>> Unknown user" });
    }

    console.log("Creating user: " + user);
    
    // either get or create this user (if not yet existing)
    const userId = await getUser(user);
    
    // console.log("Generating JWT for user: " + user);
    const jwt = await generateJWT(user);
        
    return res.status(200).json({ name: user, userId: userId, token: jwt, dc: dc, phone: serviceNumber });
})

//--------

async function getUser(name) {
    
  const accessToken = tokenGenerate(appId, privateKey, {});
  
  return new Promise(async (resolve, reject) => {
    
    let results;
    
    try {
      results = await axios.get('https://api.nexmo.com/v0.3/users?name=' + name,
        {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + accessToken
            }
        });

      //-- debug
      // console.log(">>> results.data:", results.data);
      // console.log("User Retrieval results: ", results.data._embedded.users[0].id);
      
      // If user already exists, just use it!
      resolve(results.data._embedded.users[0].id);
      return;
    } 
    catch (err) {

        console.log(">>> err.response:", err.response);
        // console.log("User retrieval error: ", err.response.data)
    }
    
    // Here - user does NOT exist, create it
    try {
        let body = {
            name: name,
            display_name: name
        }
        results = await axios.post('https://api.nexmo.com/v0.3/users', body,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + accessToken
                }
            });
        
        // debug
        // console.log("User creation results: ", results.data);
        
        // New user created, pass back the id
        resolve(results.data.id);
        
        return;
    } 
    catch (err) {
        console.log(">>> User creation error:", err);
        console.log("User creation error: ", err.response?.statusText)
        
        resolve(null);
    }
  })

}

//--------

app.post('/logout', async (req, res) => {
    
    let user = req.body.user;
    let session = req.body.session;
    
    // console.log("Deleting session: " + session);
    await delSession(session);

    return res.status(200).end();
})

//--------

async function generateJWT(sub) {
    
    // Generate a JWT with the appropriate ACL
    let jwtExpiration = Math.round(new Date().getTime() / 1000) + 2592000; //30 days
    
    const aclPaths = {
        "paths": {
            "/*/users/**": {},
            "/*/conversations/**": {},
            "/*/sessions/**": {},
            "/*/devices/**": {},
            "/*/image/**": {},
            "/*/media/**": {},
            "/*/applications/**": {},
            "/*/push/**": {},
            "/*/knocking/**": {},
            "/*/legs/**": {}
        }
    }
    let claims = {
        exp: jwtExpiration,
        //ttl: 86400,
        acl: aclPaths,
    }
    
    // ONLY Client JWTs use a "sub", so don't add one if it is already passed in
    if (sub != null) {
        claims.sub = sub
    }
    
    // debug
    // console.log(appId, privateKey, claims);
    
    const jwt = tokenGenerate(appId, privateKey, claims)
    
    // console.log("Jwt: ", jwt)
    
    return (jwt);
}

//--------

async function delSession(session) {

  const accessToken = tokenGenerate(appId, privateKey, {});
  
  return new Promise(async (resolve, reject) => {

    let results;

    try {
      results = await axios.delete('https://api.nexmo.com/v0.3/sessions/' + session,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + accessToken
          }
        });
      // console.log("User session deletion results: ", results.data);
      resolve(results.data);
      return;
    } 
    catch (err) {
      console.log("User session deletion error: ", err)
    }
  })

}

//--------------- for VCR ----------------

app.get('/_/health', async (req, res) => {
   
  res.status(200).send('Ok');

});

//========== Static HTTP server ===========

app.use ('/', express.static(__dirname + '/public')); // static web server

//=========================================

const port = process.env.VCR_PORT || process.env.PORT || 8000;

app.listen(port, () => console.log(`Application listening on port ${port}`));

//------------
