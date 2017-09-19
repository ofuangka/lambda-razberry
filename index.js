'use strict';

var http = require('https'),
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
        zwitch: 'zwitch',
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

function log() {
    console.log.apply(console, Array.prototype.map.call(arguments, argument =>
        typeof argument === 'object' ? JSON.stringify(argument) : argument));
}
function verbose() {
    if (isVerbose) {
        log.apply(null, arguments);
    }
}
function httpPromise(options, postString) {
    var startMs = Date.now();
    verbose('REQ', options.method, options.path, postString);
    return new Promise((resolve, reject) => {
        var request = http.request(options, response => {
            var data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                if (response.statusCode === 200) {
                    verbose('RESP', options.path, data, `${Date.now() - startMs}ms`);
                    resolve(JSON.parse(data));
                } else {
                    log('HTTP', response.statusCode, options.path, data, `${Date.now() - startMs}ms`);
                    reject(new Error(`HTTP ${response.statusCode}`));
                }
            });
        });
        request.on('error', error => {
            log('ERR', options.path, error, `${Date.now() - startMs}ms`);
            reject(error);
        });
        if (typeof postString === 'string') {
            request.write(postString);
        }
        request.end();
    });
}
function get(path) {
    return httpPromise(Object.assign({ method: 'GET', path: path }, getOptions()));
}
function post(path, postData) {
    var postBody = typeof postData === 'object' ? JSON.stringify(postData) : postData;
    return httpPromise(Object.assign({ method: 'POST', path: path }, getOptions(postBody)), postBody);
}
function getOptions(postString) {
    return {
        hostname: remoteHost,
        port: remotePort,
        headers: {
            Accept: '*/*',
            'Content-Type': 'application/json',
            'Content-Length': typeof postString === 'string' ? Buffer.byteLength(postString) : 0
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

function getReply(namespace, name, payload) {
    return {
        event: {
            header: {
                messageId: `${Date.now()}`,
                name: name,
                namespace: namespace,
                payloadVersion: '3'
            },
            payload: payload || {}
        }
    };
}

function getErrorReply() {
    var args = arguments.length === 1 ? [arguments[0]] : Array.apply(null, arguments);
    var message = args
        .slice(1)
        .map(arg => typeof arg === 'object' ? JSON.stringify(arg) : arg)
        .join(' ');
    return getReply('Alexa', 'ErrorResponse', {
        type: args[0],
        message: message
    });
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
    if (type === SUPPORTED_ENDPOINT_TYPES.zwitch
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
function getDiscoveryReply(endpoints) {
    var compatibleEndpoints = endpoints
        .filter(isEndpointSupported)
        .map(endpoint => {
            return {
                endpointId: endpoint.id.replace('.', '#'),
                manufacturerName: endpoint.manufacturer,
                friendlyName: endpoint.name,
                description: endpoint.description,
                displayCategories: [],
                capabilities: getEndpointCapabilities(endpoint)
            };
        });
    return getReply(SUPPORTED_INTERFACES.Alexa_Discovery, 'Discover.Response', { endpoints: compatibleEndpoints });
}
function getPowerControlReply(power) {
    return Object.assign({
        context: {
            properties: [{
                namespace: SUPPORTED_INTERFACES.Alexa_PowerController,
                name: 'powerState',
                value: power.state,
                timeOfSample: power.isoTimestamp,
                uncertaintyInMilliseconds: power.uncertaintyMs
            }]
        }
    }, getReply('Alexa', 'Response'));
}

function getDirectiveName(event) {
    return event.directive.header.name;
}

function getInvalidDirectiveReply(directiveName) {
    return getErrorReply(ERROR_TYPES.invalidDirective, directiveName);
}

function succeed(reply, context) {
    verbose(reply);
    context.succeed(reply);
}

function fail(reply, context) {
    log(reply);
    context.fail(reply);
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
        .then(getDiscoveryReply)
        .then(reply => succeed(reply, context))
        .catch(error => {
            log(error);

            /* we're never supposed to return an error for a discovery response */
            context.succeed(getDiscoveryReply([]));
        });
}

function getEndpointId(event) {
    return event.directive.endpoint.endpointId.replace('#', '.');
}

function getEndpointToken(event) {
    return event.directive.endpoint.scope.token;
}

function handlePowerControlEvent(event, context) {
    var directiveName = getDirectiveName(event);
    if (!/^TurnO(n|ff)$/.test(directiveName)) {
        fail(getInvalidDirectiveReply(directiveName), context);
    } else {
        var endpointId = getEndpointId(event),
            accessToken = getEndpointToken(event),
            postData = { state: directiveName === 'TurnOn' ? 'on' : 'off' };
        post(`/endpoints/${endpointId}/power?access_token=${accessToken}`, postData)
            .then(getPowerControlReply)
            .then(reply => succeed(reply, context))
            .catch(error => fail(getServiceErrorReply(error), context));
    }
}
function getServiceErrorReply(error) {
    return getErrorReply(ERROR_TYPES.endpointUnreachable, error);
}
function getChannelReply(channel) {
    return Object.assign({
        context: {
            properties: [{
                namespace: 'Alexa.ChannelController',
                name: 'channel',
                value: {
                    number: channel.state
                },
                timeOfSample: channel.isoTimestamp,
                uncertaintyInMilliseconds: channel.uncertaintyMs
            }]
        }
    }, getReply('Alexa', 'Response'));
}
function getInputReply(input) {
    return Object.assign({
        context: {
            properties: [{
                namespace: 'Alexa.InputController',
                name: 'input',
                value: input.state,
                timeOfSample: input.isoTimestamp,
                uncertaintyInMilliseconds: input.uncertaintyMs
            }]
        }
    }, getReply('Alexa', 'Response'));
}
function getStepSpeakerReply() {
    return getReply('Alexa', 'Response');
}
function handleChangeChannelEvent(event, context) {
    var endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event),

        /* combine the channel with the channelMetadata */
        postData = Object.assign({
            metadata: event.directive.payload.channelMetadata
        }, event.directive.payload.channel);
    post(`/endpoints/${endpointId}/channel?access_token=${accessToken}`, postData)
        .then(getChannelReply)
        .then(reply => succeed(reply, context))
        .catch(error => fail(getServiceErrorReply(error), context));
}
function handleSkipChannelsEvent(event, context) {
    var endpointId = getEndpointId(event),
        postData = { delta: event.directive.payload.channelCount };
    post(`/endpoints/${endpointId}/channel`, postData)
        .then(getChannelReply)
        .then(reply => succeed(reply, context))
        .catch(error => fail(getServiceErrorReply(error), context));
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
            fail(getInvalidDirectiveReply(directiveName), context);
            break;
    }
}
function handleInputControlEvent(event, context) {
    var directiveName = getDirectiveName(event),
        endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event),
        postData = { input: event.directive.payload.input };
    switch (directiveName) {
        case 'SelectInput':
            post(`/endpoints/${endpointId}/input?access_token=${accessToken}`, postData)
                .then(getInputReply)
                .then(reply => succeed(reply, context))
                .catch(error => fail(getServiceErrorReply(error)), context);
            break;
        default:
            fail(getInvalidDirectiveReply(directiveName), context);
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
            postData = { mute: event.directive.payload.mute };
            break;
        case 'AdjustVolume':
            postData = { delta: event.directive.payload.volumeSteps };
            break;
        default:
            fail(getInvalidDirectiveReply(directiveName), context);
            return;
    }
    post(`/endpoints/${endpointId}/volume?accessToken=${accessToken}`, postData)
        .then(getStepSpeakerReply)
        .then(reply => succeed(reply, context))
        .catch(error => fail(getServiceErrorReply(error), context));
}
function isPlaybackDirectiveValid(directiveName) {
    return SUPPORTED_PLAYBACK_DIRECTIVES.indexOf(directiveName) !== -1;
}
function getPlaybackControlReply(response) {
    return Object.assign({ context: { properties: [] } }, getReply('Alexa', 'Response'));
}
function handlePlaybackControlEvent(event, context) {
    var directiveName = getDirectiveName(event),
        endpointId = getEndpointId(event),
        accessToken = getEndpointToken(event);
    if (isPlaybackDirectiveValid(directiveName)) {
        var postData = { directive: directiveName };
        post(`/endpoints/${endpointId}/playback?accessToken=${accessToken}`, postData)
            .then(getPlaybackControlReply)
            .then(reply => succeed(reply, context))
            .catch(error => fail(getServiceErrorReply(error), context));
    } else {
        fail(getInvalidDirectiveReply(directiveName), context);
    }
}
exports.handler = (event, context) => {
    verbose('event', event, 'context', context);
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
                fail(getErrorReply(ERROR_TYPES.internalError, 'Unsupported namespace', namespace), context);
                break;
        }
    } else {
        fail(getErrorReply(ERROR_TYPES.internalError, 'Invalid event', event), context);
    }
};