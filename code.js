var http = require('http'),
    REMOTE_HOST = process.env.REMOTE_HOST,
    REMOTE_PORT = process.env.REMOTE_PORT;

exports.handler = function (event, context) {

    console.log('Event received: ' + event);

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
            console.log('Unsupported namespace: ' + event.header.namespace);
            context.fail('Something went wrong');
            break;
    }
};

/**
 * This method is invoked when we receive a "Discovery" message from Alexa Smart Home Skill.
 * We are expected to respond back with a list of appliances that we have discovered for a given
 * customer. 
 */
function handleDiscovery(event, context) {

    function getDiscoveryResponse(discoveredAppliances) {
        return {
            header: {
                messageId: '' + new Date().getTime(),
                name: 'DiscoverAppliancesResponse',
                namespace: 'Alexa.ConnectedHome.Discovery',
                payloadVersion: '2'
            },
            payload: {
                discoveredAppliances: discoveredAppliances
            }
        };
    }

    var accessToken = event.payload.accessToken.trim();

    /* make the remote server request */
    http.get('http://' + REMOTE_HOST + ':' + REMOTE_PORT + '/devices?access_token=' + accessToken, function (connect) {

        var message = '';
        connect.on('data', function (chunk) {
            message += chunk;
        });
        connect.on('end', function () {

            /**
             * Response body will be an array of discovered devices.
             */
            var discoveredAppliances = [];

            JSON.parse(message).forEach(function (device) {

                /* filter out unsupported devices */
                if (device.id &&
                    device.metrics &&
                    device.metrics.title &&
                    device.metrics.level &&
                    (device.metrics.level === 'on' || device.metrics.level === 'off')
                ) {
                    discoveredAppliances.push({
                        applianceId: device.id,
                        manufacturerName: 'Unknown',
                        modelName: 'Unknown',
                        version: 'Unknown',
                        friendlyName: device.metrics.title,
                        friendlyDescription: device.metrics.title,
                        isReachable: true,
                        actions: ['turnOn', 'turnOff']
                    });
                }
            });

            var result = getDiscoveryResponse(discoveredAppliances);

            console.log('Discovery: ' + result);
            context.succeed(result);
        });
    }).on('error', function () {

        /* we're never supposed to return an error for a discovery request' */
        context.succeed(getDiscoveryResponse([]));
    });
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
    if (!event.header.name.match(/^TurnO(n|ff)Request$/)) {
        context.fail(generateError('UnsupportedOperationError', 'Alexa.ConnectedHome.Control'));
    } else {

        /**
         * Retrieve the appliance id and accessToken from the incoming message.
         */
        var applianceId = event.payload.appliance.applianceId,
            accessToken = event.payload.accessToken.trim(),

            /**
             * Make a remote call to execute the action based on accessToken and the applianceId and the switchControlAction
             * Some other examples of checks:
             *	validate the appliance is actually reachable else return TARGET_OFFLINE error
             *	validate the authentication has not expired else return EXPIRED_ACCESS_TOKEN error
             * Please see the technical documentation for detailed list of errors
             */
            basePath = '/devices/' + applianceId + '?access_token=' + accessToken,

            postData = JSON.stringify({
                level: ((event.header.name === 'TurnOnRequest') ? 'on' : 'off')
            }),

            options = {
                method: 'PUT',
                hostname: REMOTE_HOST,
                port: REMOTE_PORT,
                path: basePath,
                headers: {
                    accept: '*/*',
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                }
            },

            callback = function (connect) {
                var message = '';

                connect.on('data', function (chunk) {
                    message += chunk.toString('utf-8');
                });

                connect.on('end', function () {

                    /* inspect the result */

                    var response = {
                        header: {
                            messageId: '' + new Date().getTime(),
                            namespace: 'Alexa.ConnectedHome.Control',
                            name: (event.header.name === 'TurnOnRequest') ? 'TurnOnConfirmation' : 'TurnOffConfirmation',
                            payloadVersion: '2'
                        },
                        payload: {}
                    };
                    console.log('Confirmation: ', response);
                    context.succeed(response);
                });
            },
            request = http.request(options, callback);
        request.on('error', function (error) {
            console.log('Error: ' + error.message);
            context.fail(generateError('DependentServiceUnavailableError', 'Alexa.ConnectedHome.Control'));
        });
        request.write(postData);
        request.end();
    }
}

function generateError(name, namespace) {
    return {
        header: {
            messageId: '' + new Date().getTime(),
            namespace: namespace,
            name: name,
            payloadVersion: '2'
        },
        payload: {}
    };
}