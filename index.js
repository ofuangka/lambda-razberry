var http = require('http'),
    REMOTE_HOST = process.env.REMOTE_HOST,
    REMOTE_PORT = process.env.REMOTE_PORT;

/**
 * cheap polyfill for Object.assign()
 */
function assign(target) {
	for (var i = 1; i < arguments.length; i++) {
		var source = arguments[i];
		for (var nextKey in source) {
			if (source.hasOwnProperty(nextKey)) {
				target[nextKey] = source[nextKey];
			}
		}
	}
	return target;
}

/**
 * promise wrapper for http
 */
function httpPromise(options, postData) {
    return new Promise((resolve, reject) => {
        var outRequest = http.request(options, outResponse => {
            var data = '';
            outResponse.on('data', chunk => data += chunk);
            outResponse.on('end', () => {
                resolve({
                    statusCode: outResponse.statusCode,
                    headers: outResponse.headers,
                    responseText: data
                });
            });
        });
        outRequest.on('error', error => reject(error));
        if (postData !== undefined) {
            outRequest.write(postData);
        }
        outRequest.end();
    });
}

function get(path, options) {
    return httpPromise(assign({ method: 'GET', path: path }, options));
}
function put(path, postData, options) {
    return httpPromise(assign({ method: 'PUT', path: path }, options), postData);
}
function getResponse(name, namespace, payload) {
    return {
        header: {
            messageId: `${Date.now()}`,
            name: name,
            namespace: namespace,
            payloadVersion: '2'
        },
        payload: payload === undefined ? {} : payload
    };
}
function getDiscoveryResponse(discoveredAppliances) {
    return getResponse('DiscoverAppliancesResponse', 'Alexa.ConnectedHome.Discovery', discoveredAppliances);
}
function getOptions(postData) {
    return {
        hostname: REMOTE_HOST,
        port: REMOTE_PORT,
        headers: {
            accept: '*/*',
            'Content-Type': 'application/json',
            'Content-Length': typeof postData === 'string' ? Buffer.byteLength(postData) : 0
        }
    };
}
/**
 * This method is invoked when we receive a "Discovery" message from Alexa Smart Home Skill.
 * We are expected to respond back with a list of appliances that we have discovered for a given
 * customer. 
 */
function handleDiscovery(event, context) {

    var accessToken = event.payload.accessToken.trim();

    /* make the remote server request */
    get(`/devices?access_token=${accessToken}`, getOptions())
        .then(response => {
            console.log(`rawResponse: ${response.responseText}`);
            return JSON.parse(response.responseText);
        })
        .then(appliances => appliances
            .filter(appliance => appliance.id
                && appliance.metrics
                && appliance.metrics.title
                && appliance.metrics.level
                && /^(on|off)$/.test(appliance.metrics.level))
            .map(appliance => {
                return {
                    applianceId: appliance.id,
                    manufacturerName: 'Unknown',
                    modelName: 'Unknown',
                    version: 'Unknown',
                    friendlyName: appliance.metrics.title,
                    friendlyDescription: appliance.metrics.title,
                    isReachable: true,
                    actions: ['turnOn', 'turnOff']
                };
            })
        )
        .then(validAppliances => {
            var response = getDiscoveryResponse(validAppliances);
            console.log(`Discovery: ${JSON.stringify(response)}`);
            context.succeed(response);
        })
        .catch(error => {
            console.log(`Discovery error: ${JSON.stringify(error)}`);

            /* we're never supposed to return an error for a discovery response */
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
        context.fail(getResponse('UnsupportedOperationError', 'Alexa.ConnectedHome.Control'));
    } else {

        /**
         * Retrieve the appliance id and accessToken from the incoming message.
         */
        var applianceId = event.payload.appliance.applianceId,
            accessToken = event.payload.accessToken.trim(),
            postData = JSON.stringify({
                level: ((event.header.name === 'TurnOnRequest') ? 'on' : 'off')
            });
        
        put(`/devices/${applianceId}?access_token=${accessToken}`, postData, getOptions(postData))
            .then(response => {
                if (response.statusCode === 200) {
                    var name = event.header.name === 'TurnOnRequest' ? 'TurnOnConfirmation' : 'TurnOffConfirmation',
                        confirmation = getResponse(name, 'Alexa.ConnectedHome.Control');
                    console.log(`Confirmation: ${JSON.stringify(confirmation)}`);
                    context.succeed(confirmation);
                } else {
                    throw new Error(`Unexpected HTTP statusCode ${response.statusCode}`);
                }
            })
            .catch(error => {
                console.log(`Error: ${JSON.stringify(error)}`);
                context.fail(getResponse('DependentServiceUnavailableError', 'Alexa.ContextHome.Control', {
                    dependentServiceName: 'z-way-relay'
                }));
            });
    }
}

exports.handler = (event, context) => {
    console.log(`Event received: ${JSON.stringify(event)}`);
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
            console.log(`Unsupported namespace: ${event.header.namespace}`);
            context.fail(getResponse('UnsupportedOperationError', 'Alexa.ConnectedHome.Control'));
            break;
    }
};