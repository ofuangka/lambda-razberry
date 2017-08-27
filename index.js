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
    },
    SUPPORTED_PLAYBACK_DIRECTIVES = [
        'FastForward',
        'Next',
        'Pause',
        'Play',
        'Previous',
        'Rewind',
        'StartOver',
        'Stop'
    ];

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
    })
        .then(response => {
            if (response.statusCode !== 200) {
                throw new Error(`HTTP ${response.statusCode}`);
            }
            return response;
        });
}

function get(path) {
    verbose('GET', path);
    return httpPromise(assign({ method: 'GET', path: path }, getOptions()));
}

function put(path, postData) {
    verbose('PUT', path, postData);
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
    log('errorResponse:', ret);
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
    }
    if (type === SUPPORTED_ENDPOINT_TYPES.television) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_StepSpeaker));
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_InputController));
    }
    if (type === SUPPORTED_ENDPOINT_TYPES.roku) {
        ret.push(getCapability(SUPPORTED_INTERFACES.Alexa_PlaybackController));
    }
    return ret;
}
function getDiscoveryAlexaResponse(alexaEndpoints) {
    var ret = getResponse(SUPPORTED_INTERFACES.Alexa_Discovery, 'Discover.Response', { endpoints: alexaEndpoints });
    verbose('discoveryAlexaResponse:', ret);
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
    verbose('powerControlAlexaResponse:', ret);
    return ret;
}
function log() {
    console.log.apply(console, Array.prototype.map.call(arguments, argument =>
        typeof argument === 'object' ? JSON.stringify(argument) : argument));
}
function verbose() {
    if (isVerbose) {
        log.apply(null, arguments);
    }
}

function getDirectiveName(event) {
    return event.directive.header.name;
}

function failInvalidDirective(context, directiveName) {
    context.fail(getErrorResponse(ERROR_TYPES.invalidDirective, `Unsupported directive: ${directiveName}`));
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
        .then(alexaEndpoints => context.succeed(getDiscoveryAlexaResponse(alexaEndpoints)))
        .catch(getError => {
            log('discoveryGetError:', getError);

            /* we're never supposed to return an error for a discovery response */
            context.succeed(getDiscoveryAlexaResponse([]));
        });
}

function getEndpointId(event) {
    return event.directive.endpoint.endpointId;
}

function getEndpointToken(event) {
    return event.directive.endpoint.scope.token;
}

/**
 * PowerControl events are processed here.
 * This is called when Alexa requests an action (IE turn off appliance).
 */
function handlePowerControlEvent(event, context) {
    var directiveName = getDirectiveName(event);

    if (!/^TurnO(n|ff)$/.test(directiveName)) {
        failInvalidDirective(context, directiveName);
    } else {

        /**
         * Retrieve the endpointId and accessToken from the incoming message.
         */
        var endpointId = getEndpointId(event),
            accessToken = getEndpointToken(event),
            postData = JSON.stringify({
                state: directiveName === 'TurnOn' ? 'on' : 'off'
            });

        put(`/endpoints/${endpointId}/power?access_token=${accessToken}`, postData)
            .then(endpointResponse => context.succeed(getPowerControlAlexaResponse(endpointResponse)))
            .catch(putError => context.fail(getPutErrorResponse(putError)));
    }
}
function getPutErrorResponse(error) {
    return getErrorResponse(ERROR_TYPES.endpointUnreachable, `Failed PUT request: ${JSON.stringify(error)}`);
}
function getChannelAlexaResponse(endpointResponse) {
    var channel = JSON.parse(endpointResponse.responseText);
    var ret = assign({
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
    verbose('channelAlexaResponse:', ret);
    return ret;
}
function getInputAlexaResponse(endpointResponse) {
    var input = JSON.parse(endpointResponse.responseText);
    var ret = assign({
        context: {
            properties: [{
                namespace: 'Alexa.InputController',
                name: 'input',
                value: input.name,
                timeOfSample: input.isoTimestamp,
                uncertaintyInMilliseconds: input.uncertaintyMs
            }]
        }
    }, getResponse('Alexa', 'Response'));
    verbose('inputAlexaResponse:', ret);
    return ret;
}
function getStepSpeakerAlexaResponse(endpointResponse) {
    var ret = getResponse('Alexa', 'Response');
    verbose('stepSpeakerAlexaResponse:', ret);
    return ret;
}
function handleChangeChannelEvent(event, context) {
    var endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event),

        /* combine the alexaChannel with the alexaChannelMetadata */
        postData = JSON.stringify(assign({
            metadata: event.directive.payload.channelMetadata
        }, event.directive.payload.channel));
    put(`/endpoints/${endpointId}/channel?access_token=${accessToken}`, postData)
        .then(endpointResponse => context.success(getChannelAlexaResponse(endpointResponse)))
        .catch(putError => context.fail(getPutErrorResponse(putError)));
}
function handleSkipChannelsEvent(event, context) {
    var endpointId = getEndpointId(event),
        postData = JSON.stringify({
            channelCount: event.directive.payload.channelCount
        });
    put(`/endpoints/${endpointId}/channel`, postData)
        .then(endpointResponse => context.success(getChannelAlexaResponse(endpointResponse)))
        .catch(putError => context.fail(getPutErrorResponse(putError)));
}
function handleChannelControlEvent(event, context) {
    var directiveName = getDirectiveName(event);
    switch (directiveName) {
        case 'ChangeChannel':
            handleChangeChannelEvent(event, context);
            break;
        case 'SkipChannels':
            handleSkipChannelsEvent(event, context);
            break;
        default:
            failInvalidDirective(context, directiveName);
            break;
    }
}
function handleInputControlEvent(event, context) {
    var directiveName = getDirectiveName(event),
        endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event),
        postData = JSON.stringify({ name: event.directive.payload.input });
    switch (directiveName) {
        case 'SelectInput':
            put(`/endpoints/${endpointId}/input?access_token=${accessToken}`, postData)
                .then(endpointResponse => context.success(getInputAlexaResponse(endpointResponse)))
                .catch(putError => context.fail(getPutErrorResponse(putError)));
            break;
        default:
            failInvalidDirective(context, directiveName);
            break;
    }
}
function handleStepSpeakerEvent(event, context) {
    var directiveName = getDirectiveName(event),
        endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event),
        postData;
    switch (directiveName) {
        case 'SetMute':
            postData = JSON.stringify({ mute: event.directive.payload.mute });
            break;
        case 'AdjustVolume':
            postData = JSON.stringify({ volumeSteps: event.directive.payload.volumeSteps });
            break;
        default:
            failInvalidDirective(context, directiveName);
            return;
    }
    put(`/endpoints/${endpointId}/volume?accessToken=${accessToken}`, postData)
        .then(endpointResponse => context.success(getStepSpeakerAlexaResponse(endpointResponse)))
        .catch(putError => context.fail(getPutErrorResponse(putError)));
}
function isPlaybackDirectiveValid(directiveName) {
    return SUPPORTED_PLAYBACK_DIRECTIVES.indexOf(directiveName) !== -1;
}
function getPlaybackControlAlexaResponse(endpointResponse) {
    var ret = getResponse('Alexa', 'Response');
    verbose('playbackControlAlexaResponse:', ret);
    return ret;
}
function handlePlaybackControlEvent(event, context) {
    var directiveName = getDirectiveName(event),
        endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event);
    if (isPlaybackDirectiveValid(directiveName)) {
        var postData = JSON.stringify({ directive: directiveName });
        put(`/endpoints/${endpointId}/playback?accessToken=${accessToken}`, postData)
            .then(endpointResponse => context.success(getPlaybackControlAlexaResponse(endpointResponse)))
            .catch(putError => context.fail(getPutErrorResponse(putError)));
    } else {
        failInvalidDirective(context, directiveName);
    }
}
exports.handler = (event, context) => {
    verbose('event:', event, 'context:', context);
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
            case SUPPORTED_INTERFACES.Alexa_PlaybackController:
                handlePlaybackControlEvent(event, context);
                break;
            default:
                context.fail(getErrorResponse(ERROR_TYPES.internalError, `Unsupported namespace: ${namespace}`));
                break;
        }
    } else {
        context.fail(getErrorResponse(ERROR_TYPES.internalError, `Invalid event: ${JSON.stringify(event)}`));
    }
};