var http = require('http'),
    remoteHost = process.env.REMOTE_HOST,
    remotePort = process.env.REMOTE_PORT;

const ERROR_TYPES = {
    ENDPOINT_UNREACHABLE: 'ENDPOINT_UNREACHABLE',
    NO_SUCH_ENDPOINT: 'NO_SUCH_ENDPOINT',
    INVALID_VALUE: 'INVALID_VALUE',
    VALUE_OUT_OF_RANGE: 'VALUE_OUT_OF_RANGE',
    TEMPERATURE_VALUE_OUT_OF_RANGE: 'TEMPERATURE_VALUE_OUT_OF_RANGE',
    INVALID_DIRECTIVE: 'INVALID_DIRECTIVE',
    FIRMWARE_OUT_OF_RANGE: 'FIRMWARE_OUT_OF_RANGE',
    HARDWARE_MALFUNCTION: 'HARDWARE_MALFUNCTION',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
    INVALID_AUTHORIZATION_CREDENTIAL: 'INVALID_AUTHORIZATION_CREDENTIAL',
    EXPIRED_AUTHORIZATION_CREDENTIAL: 'EXPIRED_AUTHORIZATION_CREDENTIAL',
    INTERNAL_ERROR: 'INTERNAL_ERROR'
},
    SUPPORTED_DEVICES = {
        switchBinary: 'switchBinary',
        roku: 'roku',
        television: 'television'
    },
    SUPPORTED_INTERFACES = {
        Alexa_Discovery: 'Alexa.Discovery',
        Alexa_PowerController: 'Alexa.PowerController',
        Alexa_ChannelController: 'Alexa.ChannelController',
        Alexa_PlaybackController: 'Alexa.PlaybackController',
        Alexa_InputController: 'Alexa.InputController',
        Alexa_StepSpeaker: 'Alexa.StepSpeaker'
    };

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
    return httpPromise(assign({ method: 'GET', path: path }, getOptions()));
}
function put(path, postData, options) {
    return httpPromise(assign({ method: 'PUT', path: path }, getOptions(postData)), postData);
}
function getOptions(postData) {
    return {
        hostname: remoteHost,
        port: remotePort,
        headers: {
            accept: '*/*',
            'Content-Type': 'application/json',
            'Content-Length': typeof postData === 'string' ? Buffer.byteLength(postData) : 0
        }
    };
}

function isEventValid(event) {
    return event
        && event.directive
        && event.directive.header
        && event.directive.header.namespace
        && event.directive.header.name;
}
function getResponse(namespace, name, payload) {
    return {
        event: {
            header: {
                messageId: `${Date.now()}`,
                name: name,
                namespace: namespace,
                payloadVersion: '3'
            },
            payload: payload === undefined ? {} : payload
        }
    };
}
function getErrorResponse(type, message) {
    return getResponse('Alexa', 'ErrorResponse', {
        type: type,
        message: message
    });
}
function isDeviceSupported(device) {
    return device
        && device.id
        && device.metrics
        && device.metrics.title
        && SUPPORTED_DEVICES.hasOwnProperty(device.deviceType);
}
function getCapability(iface) {
    return {
        'interface': iface,
        type: 'AlexaInterface',
        version: '1.0'
    };
}
function getDeviceCapabilities(device) {
    var deviceType = device.deviceType,
        ret = [];
    if (deviceType === SUPPORTED_DEVICES.switchBinary
        || deviceType === SUPPORTED_DEVICES.television) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_PowerController));
    }
    if (deviceType === SUPPORTED_DEVICES.television
        || deviceType === SUPPORTED_DEVICES.roku) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_ChannelController));
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_PlaybackController));
    }
    if (deviceType === SUPPORTED_DEVICES.television) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_StepSpeaker));
    }
    return ret;
}
function getDiscoveryResponse(endpoints) {
    return getResponse(SUPPORTED_INTERFACES.Alexa_Discovery, 'Discover.Response', { endpoints: endpoints });
}
function getPowerControlResponse(newState) {
    return assign({
        context: {
            properties: [{
                namespace: SUPPORTED_INTERFACES.Alexa_PowerController,
                name: 'powerState',
                value: newState,
                timeOfSample: `${new Date()}`,
                uncertaintyInMilliseconds: 0
            }]
        }
    }, getResponse('Alexa', 'Response'))
}
/**
 * This function is invoked when we receive a "Discovery" message from Alexa Smart Home Skill.
 * We are expected to respond back with a list of appliances that we have discovered for a given
 * customer. 
 */
function handleDiscoveryEvent(event, context) {

    var accessToken = event.directive.payload.scope.token.trim();

    /* make the remote server request */
    get(`/devices?access_token=${accessToken}`)
        .then(response => JSON.parse(response.responseText))
        .then(devices => devices
            .filter(isDeviceSupported)
            .map(device => {
                return {
                    endpointId: device.id,
                    manufacturerName: 'Unknown',
                    friendlyName: device.metrics.title,
                    description: device.metrics.title,
                    displayCategories: [],
                    capabilities: getDeviceCapabilities(device)
                };
            })
        )
        .then(endpoints => {
            var discoveryResponse = getDiscoveryResponse(endpoints);
            console.log(`Discovery success: ${JSON.stringify(discoveryResponse)}`);
            context.succeed(discoveryResponse);
        })
        .catch(error => {
            console.log(`Discovery error: ${JSON.stringify(error)}`);

            /* we're never supposed to return an error for a discovery response */
            context.succeed(getDiscoveryResponse([]));
        });
}
/**
 * PowerControl events are processed here.
 * This is called when Alexa requests an action (IE turn off appliance).
 */
function handlePowerControlEvent(event, context) {
    var directiveName = event.directive.header.name;

    if (!/^TurnO(n|ff)$/.test(directiveName)) {
        context.fail(getErrorResponse(ERROR_TYPES.INVALID_DIRECTIVE, `Unexpected directive name: ${directiveName}`));
    } else {

        /**
         * Retrieve the endpointId and accessToken from the incoming message.
         */
        var endpointId = event.directive.endpoint.endpointId,
            accessToken = event.directive.endpoint.scope.token,
            postData = JSON.stringify({
                level: (directiveName === 'TurnOn' ? 'on' : 'off')
            });

        put(`/devices/${endpointId}?access_token=${accessToken}`, postData)
            .then(response => {
                if (response.statusCode === 200) {
                    var newState = directiveName === 'TurnOn' ? 'ON' : 'OFF',
                        powerControlResponse = getPowerControlResponse(newState);
                    console.log(`PowerControlResponse: ${JSON.stringify(powerControlResponse)}`);
                    context.succeed(powerControlResponse);
                } else {
                    context.fail(getErrorResponse(ERROR_TYPES.ENDPOINT_UNREACHABLE, `Unexpected HTTP statusCode ${response.statusCode}`));
                }
            })
            .catch(error => {
                context.fail(getErrorResponse(ERROR_TYPES.ENDPOINT_UNREACHABLE, `Failed PUT request: ${JSON.stringify(error)}`));
            });
    }
}
function handleChannelControlEvent(event, context) {
    context.fail(getErrorResponse(ERROR_TYPES.INTERNAL_ERROR, 'Not yet implemented'));
}
function handleInputControlEvent(event, context) {
    context.fail(getErrorResponse(ERROR_TYPES.INTERNAL_ERROR, 'Not yet implemented'));
}
function handleStepSpeakerEvent(event, context) {
    context.fail(getErrorResponse(ERROR_TYPES.INTERNAL_ERROR, 'Not yet implemented'));
}
exports.handler = (event, context) => {
    if (isEventValid(event)) {
        var namespace = event.directive.header.namespace;
        switch (namespace) {
            case SUPPORTED_INTERFACES.Alexa_Discovery:
                handleDiscoveryEvent(event, context);
                break;
            case SUPPORTED_INTERFACES.Alexa_PowerController:
                handlePowerControlEvent(event, context);
                break;
            case SUPPORTED_INTERFACES.Alexa_InputController:
                handleInputControlEvent(event, context);
                break;
            case SUPPORTED_INTERFACES.Alexa_ChannelController:
                handleChannelControlEvent(event, context);
                break;
            case SUPPORTED_INTERFACES.Alexa_StepSpeaker:
                handleStepSpeakerEvent(event, context);
                break;
            default:
                context.fail(getErrorResponse(ERROR_TYPES.INTERNAL_ERROR, `Unsupported namespace: ${namespace}`));
                break;
        }
    } else {
        context.fail(getErrorResponse(ERROR_TYPES.INTERNAL_ERROR, `Unexpected event received: ${JSON.stringify(event)}`));
    }
};