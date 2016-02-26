var bunyan = require('bunyan'),
    has = require('lodash.has'),
    omit = require('lodash.omit'),
    set = require('lodash.set'),
    useragent = require('useragent'),
    uuid = require('node-uuid'),
    util = require('util');


module.exports = function (opts) {
    var logger = module.exports.errorLogger(opts);
    return function (req, res, next) {
        logger(null, req, res, next);
    };
};


module.exports.errorLogger = function (opts) {
    var logger, opts = opts || {}, format,
        immediate = false,
        parseUA = true,
        excludes,
        obfuscate,
        obfuscatePlaceholder,
        genReqId = defaultGenReqId,
        levelFn = defaultLevelFn,
        includesFn;

    if (opts.logger) {
      logger = opts.logger;
    }

    // default format
    format = opts.format || ":remote-address :incoming :method :url HTTP/:http-version :status-code :res-headers[content-length] :referer :user-agent[family] :user-agent[major].:user-agent[minor] :user-agent[os] :response-time ms";

    if (typeof format != 'function') {
        format = compile(format);
    }

    if (opts.hasOwnProperty('parseUA')) {
        parseUA = opts.parseUA;
    }

    if (opts.immediate) {
        immediate = opts.immediate;
    }

    if (opts.levelFn) {
        levelFn = opts.levelFn;
    }

    if (opts.excludes) {
        excludes = opts.excludes;
    }

    if (opts.obfuscate) {
        obfuscate = opts.obfuscate;
        obfuscatePlaceholder = opts.obfuscatePlaceholder || '[HIDDEN]';
    }

    if (opts.includesFn) {
        includesFn = opts.includesFn;
    }


    if (opts.genReqId) {
        genReqId = typeof genReqId == 'function' ? opts.genReqId : defaultGenReqId;
    } else if (opts.hasOwnProperty('genReqId')) {
        genReqId = false;
    }

    return function (err, req, res, next) {
        var startTime = process.hrtime();
        var loggerOpt = omit(opts, [
          'format',
          'parseUA',
          'immediate',
          'levelFn',
          'excludes',
          'obfuscate',
          'obfuscatePlaceholder',
          'includesFn'
        ]);
        var app = req.app || res.app;

        if (!logger) {
            loggerOpt.name = (loggerOpt.name || app.settings.shortname || app.settings.name || app.settings.title || 'express');
            loggerOpt.serializers = loggerOpt.serializers || {};
            loggerOpt.serializers.req = loggerOpt.serializers.req || bunyan.stdSerializers.req;
            loggerOpt.serializers.res = loggerOpt.serializers.res || bunyan.stdSerializers.res;
            err && (loggerOpt.serializers.err = loggerOpt.serializers.err || bunyan.stdSerializers.err);
            logger = bunyan.createLogger(loggerOpt);
        }

        var requestId;

        if (genReqId) {
            requestId = genReqId(req);
        }

        var childLogger = requestId !== undefined ? logger.child({req_id: requestId}) : logger;
        req.log = childLogger;

        function logging(incoming) {
            if (!incoming) {
                res.removeListener('finish', logging);
                res.removeListener('close', logging);
            }

            var status = res.statusCode,
                method = req.method,
                url = (req.baseUrl || '') + (req.url || '-'),
                referer = req.header('referer') || req.header('referrer') || '-',
                ua = parseUA ? useragent.parse(req.header('user-agent')) : req.header('user-agent'),
                httpVersion = req.httpVersionMajor + '.' + req.httpVersionMinor,
                hrtime = process.hrtime(startTime),
                responseTime = hrtime[0] * 1e3 + hrtime[1] / 1e6,
                ip, logFn;

            ip = ip || req.ip || req.connection.remoteAddress ||
                (req.socket && req.socket.remoteAddress) ||
                (req.socket.socket && req.socket.socket.remoteAddress) ||
                '127.0.0.1';

            var meta = {
                'remote-address': ip,
                'ip': ip,
                'method': method,
                'url': url,
                'referer': referer,
                'user-agent': ua,
                'body': req.body,
                'short-body': util.inspect(req.body).substring(0, 20),
                'http-version': httpVersion,
                'response-time': responseTime,
                "response-hrtime": hrtime,
                "status-code": status,
                'req-headers': req.headers,
                'res-headers': res._headers,
                'req': req,
                'res': res,
                'incoming':incoming?'-->':'<--'
            };

            err && (meta.err = err);

            var level = levelFn(status, err, meta);
            logFn = childLogger[level] ? childLogger[level] : childLogger.info;

            var json = meta;
            if (excludes) {
                json = null;
                if (!~excludes.indexOf('*')) {
                    json = {};
                    var exs = {};
                    excludes.forEach(function(ex) {
                        exs[ex] = true;
                    });

                    for (var p in meta)
                        if (!exs[p])
                          json[p] = meta[p];
                }
            }

            if (includesFn) {
                var includes = includesFn(req, res);

                if (includes) {
                    for (var p in includes) {
                        json[p] = includes[p];
                    }
                }
            }

            // obfuscate last in case we set something in our includesFn
            if (obfuscate) {
              for(var i in obfuscate) {
                var key = obfuscate[i];
                if (has(json, key)) {
                  set(json, key, obfuscatePlaceholder);
                }
              }
            }

            // Set the short-body here in case we've modified the body in obfuscate
            if (json && json.body) {
              json['short-body'] = util.inspect(json.body).substring(0, 20);
            }

            if (!json) {
                logFn.call(childLogger, format(meta));
            } else {
                logFn.call(childLogger, json, format(meta));
            }
        }


        if (immediate) {
            logging(true);
        } else {
            res.on('finish', logging);
            res.on('close', logging);
        }

        next(err);
    };
};


function compile(fmt) {
    fmt = fmt.replace(/"/g, '\\"');
    var js = '  return "' + fmt.replace(/:([-\w]{2,})(?:\[([^\]]+)\])?/g, function (_, name, arg) {
        if (arg)
            return '"\n + (meta["' + name + '"] ? (meta["' + name + '"]["' + arg + '"]|| (typeof meta["' + name + '"]["' + arg + '"] === "number"?"0": "-")) : "-") + "';
        return '"\n    + ((meta["' + name + '"]) || (typeof meta["'+name+'"] === "number"?"0": "-")) + "';
    }) + '";';
    return new Function('meta', js);
}


function defaultLevelFn(status, err) {
    if (err || status >= 500) { // server internal error or error
        return "error";
    } else if (status >= 400) { // client error
        return "warn";
    }
    return "info";
}



function defaultGenReqId(req) {
  var requestId = uuid.v4();
  req.id = requestId;
  return requestId;
}
