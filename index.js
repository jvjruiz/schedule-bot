var restify = require('restify');
var builder = require('botbuilder');
var google = require("googleapis");
var oAuth2 = google.auth.OAuth2;
var scopes = ['https://www.googleapis.com/auth/calendar'];
var configVariables = require('./secret');

var redirectURL = 'http://localhost:3978/oauthcallback';

var getOAuthClient = function() {
    return new oAuth2(configVariables.clientID, configVariables.clientSecret,redirectURL);
};

/*
	Notes:
	data can be persisted in many ways:
	- session.userData: global info for the user across all conversations
	- session.conversationData: global info for a single conversation, visible to everyone in conversation (disabled by default)
	- session.privateConversationData: global info for a single conversation, but private data for current user (cleaned up when conversation over)
	- session.dialogData: info for a single dialog instance (temp info between waterfall steps)

	do NOT store data using global vars or function closures!
*/

/* Bot Setup */

// Setup Restify Server
var server = restify.createServer();
console.log(restify.queryParser())
server.use(restify.queryParser());
server.listen(process.env.port || process.env.PORT || 3978, function () {
   console.log('%s listening to %s', server.name, server.url); 
});

// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: configVariables.appID,
    appPassword: configVariables.appPassword 
});
var bot = new builder.UniversalBot(connector);

// Listen for messages from users 
server.post('/api/messages', connector.listen());

/* Bot Dialogs */
var intents = new builder.IntentDialog();
bot.dialog('/',intents);

intents.onDefault([
    function(session, args, next) {
        if(!session.privateConversationData.name) {
            session.beginDialog('/login');
        } 
        else {
            next();
        }
    }
])

intents.matches(/^login/i, [
    function(session) {
        session.beginDialog('/login');
    },
    function(session, results) {
        session.sent('Thanks for logging in %s', session.privateConversationData.name);
    }
])

bot.dialog('/login', [
    function(session) {
        builder.Prompts.confirm(session, "Hi! Would you like to login using google? (yes or no)")
    },
    function(session, results) {
        if(results.response === true) {
            var oauth = getOAuthClient();
            var url = oauth.generateAuthUrl({ access_type: "online", scope: scopes}) + "&state=" + encodeURIComponent(JSON.stringify(session.message.address));

            session.send(new builder.Message(session).addAttachment(
                new builder.SigninCard(session)
                            .text('Authenticate with Google')
                            .button("Sign-in", url)
            ));
        }
        else {
            session.send("Okay bye");
            session.endDialog();
        }
    }
])

//OAuth Callback URL
server.get("/oauthcallback", function (req, res, next) {
    var authCode = req.query.code;
	var	address = JSON.parse(req.query.state);
	var	oauth = getOAuthClient();

	oauth.getToken(authCode, function (err, tokens) {
		if (!err) {
			bot.beginDialog(address, "/schedule", tokens);
		}
        res.send(200, {});
	});
});

//The diaglog for the scheduling interaction
bot.dialog('/schedule',[
    function (session,tokens) {
        var oauth = getOAuthClient();
        session.privateConversationData.tokens = tokens;
        session.send("Sign-in successful. Welcome to the agency scheduler.")
        builder.Prompts.time(session, "Please provide a date and time for the meeting (e.g.: July 14 at 7pm)");
    },
    function (session, results) {
        session.dialogData.reservationDate = builder.EntityRecognizer.resolveTime([results.response]);
        builder.Prompts.time(session, "When will the meeting end? (e.g.: July 14 at 7pm)");
    },
    function(session, results) {
        session.dialogData.endTime = builder.EntityRecognizer.resolveTime([results.response]);
        builder.Prompts.text(session, "Where would you like to meet?");
    },
    function(session, results) {
        session.dialogData.location = results.response;
        builder.Prompts.text(session, "What is the reason for the meeting?");
    },
    function(session, results) {
        session.dialogData.reason = results.response;
        builder.Prompts.text(session, "Who would you like to invite? (e.g. JohnDoe@gmail.com");
    },
    function(session, results,tokens) {
        session.dialogData.invitee = results.response;
        var invitee = session.dialogData.invitee;
        var location = session.dialogData.location;
        var startTime = session.dialogData.reservationDate;
        var endTime = session.dialogData.endTime;
        var reason = session.dialogData.reason;
        var event = {
            "location": location,
            "summary": reason,
            "attendees": [
                { "email": invitee }
            ],
            "start": {
                "dateTime": startTime,
                "timezone": "America/Los_Angeles"
            },
            "end": {
                "dateTime": endTime,
                "timezone": "America/Los_Angeles"
            },
            "reminders": {
                "useDefault": false,
                "overrides": [
                    {"method": 'email', 'minutes': 30}
                ]
            }
        }
        var calendar = google.calendar('v3');
        var oauth = getOAuthClient();
        var tokens = session.privateConversationData.tokens;
        oauth.setCredentials(tokens);
        calendar.events.insert({
            auth:oauth,
            calendarId: 'primary',
            resource: event,
            sendNotifications: true,
        }, function(err, event) {
            if(err) {
                session.send("There was an error making the event")
                session.endDialog();
            }
            else {
                session.send("Meeting confirmed. Meeting Details: <br/> Date/Time: %s - %s <br/>Location: %s<br/> Reason: %s URL: " + event.htmlLink,
                session.dialogData.reservationDate, session.dialogData.endTime, session.dialogData.location, session.dialogData.reason);
                session.endDialog();
            }
        })
    }
]);

