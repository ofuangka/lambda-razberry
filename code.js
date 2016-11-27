/**
 * This sample demonstrates a simple driver  built against the Alexa Lighting Api.
 * For additional details, please refer to the Alexa Lighting API developer documentation 
 * https://developer.amazon.com/public/binaries/content/assets/html/alexa-lighting-api.html
 */
var https = require('https');
var http = require('http');
var REMOTE_CLOUD_PORT = 4502;
var REMOTE_CLOUD_HOSTNAME = '72.182.37.246';

/**
 * Main entry point.
 * Incoming events from Alexa Lighting APIs are processed via this method.
 */
exports.handler = function(event, context) {

    log('Input', event);

    switch (event.header.namespace) {
        
        /**
         * The namespace of "Discovery" indicates a request is being made to the lambda for
         * discovering all appliances associated with the customer's appliance cloud account.
         * can use the accessToken that is made available as part of the payload to determine
         * the customer.
         */
        case 'Alexa.ConnectedHome.Discovery':
            handleDiscovery(event, context);
            break;

            /**
             * The namespace of "Control" indicates a request is being made to us to turn a
             * given device on, off or brighten. This message comes with the "appliance"
             * parameter which indicates the appliance that needs to be acted on.
             */
        case 'Alexa.ConnectedHome.Control':
            handleControl(event, context);
            break;

            /**
             * We received an unexpected message
             */
        default:
            log('Err', 'No supported namespace: ' + event.header.namespace);
            context.fail('Something went wrong');
            break;
    }
};

/**
 * This method is invoked when we receive a "Discovery" message from Alexa Smart Home Skill.
 * We are expected to respond back with a list of appliances that we have discovered for a given
 * customer. 
 */
function handleDiscovery(accessToken, context) {

    var serverError = function (e) {
        log('Error', e.message);
        /**
         * Craft an error response back to Alexa Smart Home Skill
         */
        context.fail(generateControlError('DiscoveryRequest', 'DEPENDENT_SERVICE_UNAVAILABLE', 'Unable to connect to server'));
    };
    
    http.get('http://' + REMOTE_CLOUD_HOSTNAME + ':' + REMOTE_CLOUD_PORT + '/devices', function (connect) {
        
        var message = '';
        connect.on('data', function (chunk) {
            message += chunk;
        });
        connect.on('end', function () {
            
            var header = {
                messageId: '' + new Date().getTime(),
                name: 'DiscoverAppliancesResponse',
                namespace: 'Alexa.ConnectedHome.Discovery',
                payloadVersion: '2'
            };
        
            /**
             * Response body will be an array of discovered devices.
             */
            var appliances = [];
            
            JSON.parse(message).forEach(function (device) {
                if (device.id && device.metrics && device.metrics.title && device.metrics.level && (device.metrics.level === 'on' || device.metrics.level === 'off')) {
                    appliances.push({
                        applianceId: device.id,
                        manufacturerName: 'Unknown',
                        modelName: 'Unknown',
                        version: 'Unknown',
                        friendlyName: device.metrics.title,
                        friendlyDescription: device.metrics.title,
                        isReachable: true,
                        actions: [ 'turnOn', 'turnOff' ]
                    });
                }
            });
        
            /**
             * Craft the final response back to Alexa Smart Home Skill. This will include all the 
             * discoverd appliances.
             */
            var payload = {
                discoveredAppliances: appliances
            };
            var result = {
                header: header,
                payload: payload
            };
        
            log('Discovery', result);
        
            context.succeed(result);
        });
    }).on('error', serverError);
}

/**
 * Control events are processed here.
 * This is called when Alexa requests an action (IE turn off appliance).
 */
function handleControl(event, context) {

    /**
     * Fail the invocation if the header is unexpected. This example only demonstrates
     * turn on / turn off, hence we are filtering on anything that is not SwitchOnOffRequest.
     */
    if (event.header.namespace != 'Alexa.ConnectedHome.Control' || !event.header.name.match(/^TurnO(n|ff)Request$/)) {
        context.fail(generateControlError('TurnOnOffRequest', 'UNSUPPORTED_OPERATION', 'Unrecognized operation'));
    } else {

        /**
         * Retrieve the appliance id and accessToken from the incoming message.
         */
        var applianceId = event.payload.appliance.applianceId;
        var accessToken = event.payload.accessToken.trim();
        log('applianceId', applianceId);

        /**
         * Make a remote call to execute the action based on accessToken and the applianceId and the switchControlAction
         * Some other examples of checks:
         *	validate the appliance is actually reachable else return TARGET_OFFLINE error
         *	validate the authentication has not expired else return EXPIRED_ACCESS_TOKEN error
         * Please see the technical documentation for detailed list of errors
         */
        var basePath = '/devices/' + applianceId + '?access_token=' + accessToken;
        
        var postData = JSON.stringify({
            level: ((event.header.name === 'TurnOnRequest') ? 'on' : 'off')
        });

        var options = {
            method: 'PUT',
            hostname: REMOTE_CLOUD_HOSTNAME,
            port: REMOTE_CLOUD_PORT,
            path: basePath,
            headers: {
                accept: '*/*',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        var serverError = function (e) {
            log('Error', e.message);
            /**
             * Craft an error response back to Alexa Smart Home Skill
             */
            context.fail(generateControlError('UnsupportedOperationError'));
        };

        var callback = function(response) {
            var str = '';

            response.on('data', function(chunk) {
                str += chunk.toString('utf-8');
            });

            response.on('end', function() {
                /**
                 * Test the response from remote endpoint (not shown) and craft a response message
                 * back to Alexa Smart Home Skill
                 */
                log('done with result');
                var header = {
                    messageId: '' + new Date().getTime(),
                    namespace: 'Alexa.ConnectedHome.Control',
                    name: (event.header.name === 'TurnOnRequest') ? 'TurnOnConfirmation' : 'TurnOffConfirmation',
                    payloadVersion: '2'
                };
                var result = {
                    header: header,
                    payload: {}
                };
                log('Done with result', result);
                context.succeed(result);
            });

            response.on('error', serverError);
        };

        /**
         * Make an HTTP call to remote endpoint.
         */
        var request = http.request(options, callback);
        request.on('error', serverError)
        request.write(postData);
        request.end();
    }
}

/**
 * Utility functions.
 */
function log(title, msg) {
    console.log('*************** ' + title + ' *************');
    console.log(msg);
    console.log('*************** ' + title + ' End*************');
}

function generateControlError(name) {
    var header = {
        messageId: '' + new Date().getTime(),
        namespace: 'Alexa.ConnectedHome.Control',
        name: name,
        payloadVersion: '2'
    };

    var result = {
        header: header,
        payload: {}
    };

    return result;
}
