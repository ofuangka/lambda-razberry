'use strict';

var http = require('http'),
    remoteHost = process.env.REMOTE_HOST,
    remotePort = process.env.REMOTE_PORT,
    isVerbose = process.env.IS_VERBOSE;

const ERROR_TYPES = {
        endpointUnreachable: 'ENDPOINT_UNREACHABLE',
        noSuchEndpoint: 'NO_SUCH_ENDPOINT',
        invalidValue: 'INVALID_VALUE',
        valueOutOfRange: 'VALUE_OUT_OF_RANGE',
        temperatureValueOutOfRange: 'TEMPERATURE_VALUE_OUT_OF_RANGE',
        invalidDirective: 'INVALID_DIRECTIVE',
        firmwareOutOfRange: 'FIRMWARE_OUT_OF_RANGE',
        hardwareMalfunction: 'HARDWARE_MALFUNCTION',
        rateLimitExceeded: 'RATE_LIMIT_EXCEEDED',
        invalidAuthorizationCredential: 'INVALID_AUTHORIZATION_CREDENTIAL',
        expiredAuthorizationCredential: 'EXPIRED_AUTHORIZATION_CREDENTIAL',
        internalError: 'INTERNAL_ERROR'
    },
    SUPPORTED_ENDPOINT_TYPES = {
        switchBinary: 'switchBinary',
        roku: 'roku',
        television: 'television'
    },
    ROKU = {
        id: SUPPORTED_ENDPOINT_TYPES.roku
    },
    TV = {
        id: 'tv'
    },
    TELEVISION = {
        id: SUPPORTED_ENDPOINT_TYPES.television
    },
    SUPPORTED_INTERFACES = {
        Alexa_Discovery: 'Alexa.Discovery',
        Alexa_PowerController: 'Alexa.PowerController',
        Alexa_ChannelController: 'Alexa.ChannelController',
        Alexa_PlaybackController: 'Alexa.PlaybackController',
        Alexa_InputController: 'Alexa.InputController',
        Alexa_StepSpeaker: 'Alexa.StepSpeaker'
    };

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

function get(path) {
    verbose(`GET ${path}`);
    return httpPromise(assign({ method: 'GET', path: path }, getOptions()));
}

function put(path, postData) {
    verbose(`PUT ${path} ${postData}`);
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

                /* TODO: come up with a better GUID generation */
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
    var ret = getResponse('Alexa', 'ErrorResponse', {
        type: type,
        message: message
    });
    console.error(`errorResponse: ${ret}`);
    return ret;
}

function isEndpointSupported(endpoint) {
    return endpoint
        && endpoint.id
        && endpoint.name
        && endpoint.description
        && endpoint.manufacturer
        && SUPPORTED_ENDPOINT_TYPES.hasOwnProperty(endpoint.type);
}

function getCapability(_interface) {
    return {
        'interface': _interface,
        type: 'AlexaInterface',
        version: '1.0'
    };
}

function getEndpointCapabilities(endpoint) {
    var type = endpoint.type,
        ret = [];
    if (type === SUPPORTED_ENDPOINT_TYPES.switchBinary
        || type === SUPPORTED_ENDPOINT_TYPES.television) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_PowerController));
    }
    if (type === SUPPORTED_ENDPOINT_TYPES.television
        || type === SUPPORTED_ENDPOINT_TYPES.roku) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_ChannelController));
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_PlaybackController));
    }
    if (type === SUPPORTED_ENDPOINT_TYPES.television) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_StepSpeaker));
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_InputController));
    }
    return ret;
}
function getDiscoveryAlexaResponse(alexaEndpoints) {
    var ret = getResponse(SUPPORTED_INTERFACES.Alexa_Discovery, 'Discover.Response', { endpoints: alexaEndpoints });
    verbose(`discoveryAlexaResponse(${JSON.stringify(ret)})`);
    return ret;
}
function getPowerControlAlexaResponse(endpointResponse) {
    var power = JSON.parse(endpointResponse.responseText),
        ret = assign({
        context: {
            properties: [{
                namespace: SUPPORTED_INTERFACES.Alexa_PowerController,
                name: 'powerState',
                value: power.state,
                timeOfSample: power.isoTimestamp,
                uncertaintyInMilliseconds: power.uncertaintyMs
            }]
        }
    }, getResponse('Alexa', 'Response'));
    verbose(`powerControlAlexaResponse(${JSON.stringify(ret)})`);
    return ret;
}
function verbose() {
    if (isVerbose) {
        console.info.apply(console, arguments);
    }
}
/**
 * This function is invoked when we receive a "Discovery" message from Alexa Smart Home Skill.
 * We are expected to respond back with a list of appliances that we have discovered for a given
 * customer. 
 */
function handleDiscoveryEvent(event, context) {

    var accessToken = event.directive.payload.scope.token.trim();

    /* make the remote server request */
    get(`/endpoints?access_token=${accessToken}`)
        .then(endpointResponse => JSON.parse(endpointResponse.responseText))
        .then(endpoints => endpoints
            .filter(isEndpointSupported)
            .map(endpoint => {
                return {
                    endpointId: endpoint.id,
                    manufacturerName: endpoint.manufacturer,
                    friendlyName: endpoint.name,
                    description: endpoint.description,
                    displayCategories: [],
                    capabilities: getEndpointCapabilities(endpoint)
                };
            })
        )
        .then(alexaEndpoints => {
            context.succeed(getDiscoveryAlexaResponse(alexaEndpoints));
        })
        .catch(getError => {
            console.error(`Discovery error: ${JSON.stringify(getError)}`);

            /* we're never supposed to return an error for a discovery response */
            context.succeed(getDiscoveryAlexaResponse([]));
        });
}
/**
 * PowerControl events are processed here.
 * This is called when Alexa requests an action (IE turn off appliance).
 */
function handlePowerControlEvent(event, context) {
    var directiveName = event.directive.header.name;

    if (!/^TurnO(n|ff)$/.test(directiveName)) {
        context.fail(getErrorResponse(ERROR_TYPES.invalidDirective, `Unsupported directive name: ${directiveName}`));
    } else {

        /**
         * Retrieve the endpointId and accessToken from the incoming message.
         */
        var endpointId = event.directive.endpoint.endpointId,
            accessToken = event.directive.endpoint.scope.token,
            postData = JSON.stringify({
                state: directiveName === 'TurnOn' ? 'on' : 'off'
            });

        put(`/endpoints/${endpointId}/power?access_token=${accessToken}`, postData)
            .then(endpointResponse => {
                if (endpointResponse.statusCode === 200) {
                    context.succeed(getPowerControlAlexaResponse(endpointResponse));
                } else {
                    context.fail(getHttpStatusErrorResponse(endpointResponse));
                }
            })
            .catch(putError => context.fail(getPutErrorResponse(putError)));
    }
}
function getHttpStatusErrorResponse(response) {
    return getErrorResponse(ERROR_TYPES.internalError, `Unexpected HTTP statusCode: ${response.statusCode}`);
}
function getPutErrorResponse(error) {
    return getErrorResponse(ERROR_TYPES.endpointUnreachable, `Failed PUT request: ${JSON.stringify(error)}`);
}
function getAlexaChannelResponse(endpointResponse) {
    var channel = JSON.parse(endpointResponse.responseText);
    return assign({
        context: {
            properties: [{
                namespace: 'Alexa.ChannelController',
                name: 'channel',
                value: channel.channel,
                timeOfSample: channel.isoTimestamp,
                uncertaintyInMilliseconds: channel.uncertaintyMs
            }]
        }
    }, getResponse('Alexa', 'Response'));
}
function handleChangeChannelEvent(event, context) {
    var endpointId = event.directive.endpoint.endpointId,
        accessToken = event.directive.endpoint.scope.token,

        /* combine the alexaChannel with the alexaChannelMetadata */
        postData = JSON.stringify(assign({
            metadata: event.directive.payload.channelMetadata
        }, event.directive.payload.channel));
    put(`/endpoints/${endpointId}/channel?access_token=${accessToken}`, postData)
        .then(endpointResponse => {
            if (endpointResponse.statusCode === 200) {
                context.success(getAlexaChannelResponse(endpointResponse));
            } else {
                context.fail(getHttpStatusErrorResponse(endpointResponse));
            }
        })
        .catch(putError => context.fail(getPutErrorResponse(putError)));
}
function handleSkipChannelsEvent(event, context) {
    var endpointId = event.directive.endpoint.endpointId,
        postData = JSON.stringify({
            channelCount: event.directive.payload.channelCount
        });
    put(`/devices/${endpointId}/channel`, postData)
        .then(endpointResponse => {
            if (endpointResponse.statusCode === 200) {
                context.success(getAlexaChannelResponse(endpointResponse));
            } else {
                context.fail(getHttpStatusErrorResponse(endpointResponse));
            }
        })
        .catch(putError => context.fail(getPutErrorResponse(putError)));
}
function handleChannelControlEvent(event, context) {
    var directiveName = event.directive.header.name;
    switch (directiveName) {
        case 'ChangeChannel':
            handleChangeChannelEvent(event, context);
            break;
        case 'SkipChannels':
            handleSkipChannelsEvent(event, context);
            break;
        default:
            context.fail(getErrorResponse(ERROR_TYPES.invalidDirective, `Unexpected directiveName: ${directiveName}`));
            break;
    }
}
function handleInputControlEvent(event, context) {
    context.fail(getErrorResponse(ERROR_TYPES.internalError, 'Not yet implemented'));
}
function handleStepSpeakerEvent(event, context) {
    context.fail(getErrorResponse(ERROR_TYPES.internalError, 'Not yet implemented'));
}
exports.handler = (event, context) => {
    verbose(`event(${JSON.stringify(event)})`, `context(${JSON.stringify(context)})`);
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
                context.fail(getErrorResponse(ERROR_TYPES.internalError, `Unsupported namespace: ${namespace}`));
                break;
        }
    } else {
        context.fail(getErrorResponse(ERROR_TYPES.internalError, `Invalid event: ${JSON.stringify(event)}`));
    }
};