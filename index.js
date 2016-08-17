"use strict";

var serialport = require('serialport');
var Promise = require('promise');

var DEBUG = false;
exports.DEBUG = DEBUG;
exports.Modem = Modem;
exports.Command = Command;
exports.Notification = Notification;

const CommandStateInit      = 'init';
const CommandStateRejected  = 'rejected';
const CommandStateRunning   = 'running';
const CommandStateFinished  = 'finished';
const CommandStateFailed    = 'failed';
const CommandStateTimeout   = 'timeout';
const CommandStateAborted   = 'aborted';

exports.CommandStates = {
    Init        : CommandStateInit,
    Rejected    : CommandStateRejected,
    Running     : CommandStateRunning,
    Finished    : CommandStateFinished,
    Failed      : CommandStateFailed,
    Timeout     : CommandStateTimeout,
    Aborted     : CommandStateAborted
};

var defaultConfig = {
    parser: serialport.parsers.raw,
    baudRate: 115200,
    dataBits: 8,
    stopBits: 1,
    lineRegex: /^(.+)\r\n/,
    EOL: "\r\n",
    timeout: 500,
    defaultExpectdResult: "OK"
};

var NextId = 1;

function getNextId(){
    return NextId++;
}

function Modem(config)
{
    this.serial = false;

    this.inbuf = new Buffer(0);

    this.events = {};

    this.setConfig(config);

    this.bufferTimeout = 0;
    this.processCommands = false;
    this.currentCommand = false;
    this.pendingCommands = [];

    this.notifications = {};
}

function Command(buf, expectedResult, opts)
{
    if (typeof expectedResult === 'undefined') {
        throw new Error("An expected result is required, none given");
    }

    this.id = getNextId();
    this.state = CommandStateInit;
    this.result = false;

    this.buf = buf;
    this.expectedResult = expectedResult;

    opts = opts || {};

    if (typeof opts.resultProcessor === 'function') {
        this.resultProcessor = opts.resultProcessor;
    } else if (typeof opts.resultProcessor === 'undefined' || opts.resultProcessor === true) {
        if (typeof this.expectedResult === 'string') {
            this.resultProcessor = function(buf, result) {
                var r;
                if (result instanceof Array) {
                    r = result[0] == this.expectedResult;
                } else {
                    r = result == this.expectedResult;
                }
                if (r){
                    return true;
                } else {
                    return; // return undefined
                }
            };
        } else if (this.expectedResult instanceof RegExp) {
            this.resultProcessor = function(buf, matches) {
              DEBUG && buf && console.log('buf: ' + buf.toString());
              DEBUG && console.log(matches);
              return matches;
            }
        } else if (typeof this.expectedResult === 'number') {
            this.resultProcessor = function(buf, matches) {
                return buf;
            }
        }
    }

    this.timeout = opts.timeout;
}

function Notification(name, regex, handler)
{
    this.name = name;
    this.regex = regex;
    this.handler = handler;
}

Notification.prototype._generateId = function()
{
    this.id = getNextId();
};

Modem.prototype.getConfig = function()
{
    return this.config;
};

Modem.prototype.setConfig = function(newConfig){

    if (typeof newConfig === 'string'){
        newConfig = JSON.parse(config);
    }
    if (typeof newConfig !== 'object'){
        newConfig = {};
    }

    if (typeof this.config === 'undefined'){
        this.config = defaultConfig;
    }

    this.config = Object.assign(this.config, newConfig || {});


};

Modem.prototype.open = function(path)
{

    if (this.serial instanceof serialport.SerialPort && this.serial.isOpen()){
        this.serial.close();
    }


    this.serial = new serialport.SerialPort(path, {
        parser: this.config.parser,
        baudRate: this.config.baudRate,
        dataBits: this.config.dataBits,
        stopBits: this.config.stopBits,
        autoOpen: false
    });

    this._registerSerialEvents();

    var modem = this;
    return new Promise(function(resolve, reject){
        modem.serial.open(function(error){
            if (error) reject(error);
            else {
                // write a newline to the serial because it is unknown what was last written to the serial before opening
                modem.serial.write(modem.config.EOL);

                resolve(modem.serial.isOpen());
            }
        });
    });
};

Modem.prototype._registerSerialEvents = function(){
    var modem = this;

    this.serial.on('open', function(error){
        if (typeof modem.events.open === 'function'){
            modem.events.open(error);
        }
    });
    this.serial.on('data', function(data){
        modem._onData(data);

        if (typeof modem.events.data === 'function'){
            modem.events.data(data);
        }
    });
    this.serial.on('disconnect', function(error){
        // console.log('disconnect');
        if (typeof modem.events.disconnect === 'function'){
            modem.events.disconnect(error);
        }
    });
    this.serial.on('close', function(error){
        // console.log('close');
        if (typeof modem.events.close === 'function'){
            modem.events.close(error);
        }
    });
    this.serial.on('error', function(error){
        // console.log('error', error);

        if (typeof modem.events.error === 'function'){
            modem.events.error(error);
        }
    });
};

Modem.prototype.isOpen = function()
{
    if (!(this.serial instanceof serialport.SerialPort)){
        return false;
    }
    return this.serial.isOpen();
};

Modem.prototype.pauseSerial = function()
{
    if (!(this.serial instanceof serialport.SerialPort)){
        return false;
    }
    this.serial.pause();
    return this;
};

Modem.prototype.resumeSerial = function()
{
    if (!(this.serial instanceof serialport.SerialPort)){
        return false;
    }
    this.serial.resume();
    return this;
};

Modem.prototype.close = function(cb)
{
    return this._close(cb, true);
};

Modem.prototype.closeGracefully = function(cb)
{
    return this._close(cb, false);
};

Modem.prototype._close = function(cb, gracefully)
{
    if (typeof cb !== 'function') {
        if (typeof this.events.close === 'function') {
            cb = this.events.close;
        } else {
            cb = function(){};
        }
    }

    if (this.serial instanceof serialport.SerialPort){
        if (gracefully && this.processCommands && (this.currentCommand instanceof Command || this.pendingCommands.length)){
            this.addCommand("AT").done(function () {
                this.serial.close(cb);
        }.bind(this));
        } else {
            this.stopProcessing(true);
            this.serial.close(cb);
        }
    } else {
        cb();
    }
    return this;
}

Modem.prototype.on = function(event, callback)
{
    this.events[event] = callback;
    return this;
};

Modem.prototype.getInBuffer = function()
{
    return this.inbuf;
};

Modem.prototype.clearInBuffer = function()
{
    this.inbuf = new Buffer(0);
    if (this.bufferTimeout) {
        clearTimeout(this.bufferTimeout);
        this.bufferTimeout = 0;
    }
    return this;
};

Modem.prototype.getPendingCommands = function()
{
    return this.pendingCommands;
};

Modem.prototype.clearPendingCommands = function()
{
    this.pendingCommands = [];
    return this;
};

Modem.prototype.isProcessingCommands = function()
{
    return this.processCommands;
};

Modem.prototype.startProcessing = function()
{
    this.processCommands = true;
    this._checkPendingCommands();
    return this;
};

Modem.prototype.stopProcessing = function(abortCurrent, stopCallback)
{
    this.processCommands =  false;
    if (this.currentCommand instanceof Command && abortCurrent){
        this.abortCurrentCommand();
    }
    if (typeof stopCallback === 'function'){
        // if current command not yet finished, wait until it is done.
        if (this.currentCommand instanceof Command) {
            var modem = null;
            var i = setInterval(function () {
                if (modem.currentCommand instanceof Command){
                    return;
                }
                clearInterval(i);
                stopCallback();
            }, 100);
        } else {
            stopCallback();
        }
    }
    return this;
};

Modem.prototype.getCurrentCommand = function()
{
    return this.currentCommand;
};

Modem.prototype.abortCurrentCommand = function()
{
    this.currentCommand = false;
    this._clearBufferTimeout();
    this._checkPendingCommands();

    return this;
};


Modem.prototype.getNotifications = function()
{
    return this.notifications;
};

Modem.prototype.addNotification = function(notification, regex, handler)
{
    if (notification instanceof Notification){
        this.notifications[notification.name] = notification;
    } else {
        this.notifications[notification] = new Notification(notification, regex, handler);
    }
    return this;
};

Modem.prototype.removeNotification = function(name)
{
    delete this.notifications[name];
    return this;
};

Modem.prototype.clearNotifications = function()
{
    this.notifications = {};
    return this;
};



/**
 * Run command bypassing command list (processing option)
 * @param command
 */
Modem.prototype.run = function(command, expected, opts)
{
    if (!(command instanceof Command)){
        command = this._newCommand(command, expected, opts);
    }
    if (this.currentCommand instanceof Command || this.inbuf.length > 0){
        command.state = CommandStateRejected;
    } else {
        this._run(command);
    }
    return _promiseForCommand(command);
};

/**
 * Add command to processing list
 * @param command
 */
Modem.prototype.addCommand = function(command, expected, opts)
{
    if (!(command instanceof Command)){
        command = this._newCommand(command, expected, opts);
    }
    this.pendingCommands.push(command);
    this._checkPendingCommands();

    return _promiseForCommand(command);
};

function _promiseForCommand(command)
{
    return new Promise(function(resolve, reject){
        command._interval = setInterval(function(){
            if (command.state == CommandStateInit || command.state == CommandStateRunning){
                //just wait until not running anymore
                return;
            }
            clearInterval(command._interval);
            // console.log(command);
            if (command.state == CommandStateFinished){
                if (typeof command.result.processed !== 'undefined') {
                    resolve(command.result.processed);
                } else {
                    resolve(command.result);
                }
            } else {
                reject(command);
            }
        }, 100);
    });
}

Modem.prototype._newCommand = function(command, expected, opts)
{
    if (typeof expected === 'undefined'){
        return new Command(command, this.config.defaultExpectdResult, opts);
    } else {
        return new Command(command, expected, opts);
    }
}

/**
 * Read n bytes without writing any command
 * @param n
 * @param cb
 * @returns {*}
 */
Modem.prototype.read = function(n)
{
    return this.run(new Command(false, n));
};

/**
 * Write str/buffer to serial without awaiting any result
 * @param str
 * @param cb
 * @returns {*}
 */
Modem.prototype.write = function(buf)
{
    return this.run(new Command(buf, 0));
}



Modem.prototype._checkPendingCommands = function()
{
    // let current command finish
    if (this.currentCommand instanceof Command){
        return;
    }
    // require there not to be anything left in the buffer, before starting another command
    if (this.inbuf.length > 0){
        this._setBufferTimeout();
        return;
    }
    // if not processing just do nothing
    if (!this.processCommands){
        return;
    }
    // if no pending commands, we're done
    if (this.pendingCommands.length == 0){
        return;
    }


    var command = this.pendingCommands[0];
    this.pendingCommands = this.pendingCommands.slice(1);

    this._run(command);
};

Modem.prototype._run = function(command)
{
    this.currentCommand = command;
    command.state = CommandStateRunning;

    if (typeof command.buf === 'string'){
        // console.log("Serial.write",new Buffer(command.buf), command.buf);
        this.serial.write(command.buf + this.config.EOL);

        this.events.sent(Buffer.from(command.buf + this.config.EOL));
    } else if (command.buf instanceof Buffer){
        // console.log("Serial.write", command.buf);
        this.serial.write(command.buf);

        this.events.sent(command.buf);
    }

    this._setBufferTimeout();
};


Modem.prototype._onData = function(data)
{
    // update buffer
    this.inbuf = Buffer.concat([this.inbuf, data]);

    // remove newline prefixes
    if (this._trimNewlinePrefix()){
        // do not attempt to process if buffer is empty anyways
        if (this.inbuf.length == 0){
            return;
        }
    }

    // console.log("INBUF", this.inbuf, this.inbuf.toString());


    // if a command was previously sent, we are expecting a result
    if (this.currentCommand instanceof Command){

        var finishCommand = false;
        var consumeBufBytes = 0;
        var matches = null;

        if (typeof this.currentCommand.expectedResult === 'string') {
            var str = this.inbuf.toString();
            matches = str.match(this.currentCommand.expectedResult);
            if (matches) {
                consumeBufBytes = matches[0].length;
                finishCommand = true;
            }
        } else if (this.currentCommand.expectedResult instanceof RegExp){
            var str = this.inbuf.toString();
            matches = str.match(this.currentCommand.expectedResult);
            // console.log("matches?",str, matches, this.currentCommand.expectedResult.source);
            if (matches){
                finishCommand = true;
                consumeBufBytes = matches[0].length;
                // always assume
                // matches = matches[1];
            }
        } else if (typeof this.currentCommand.expectedResult === 'number') {
            // console.log('is type number');
            if (this.currentCommand.expectedResult <= this.inbuf.length) {
                finishCommand = true;
                consumeBufBytes = this.currentCommand.expectedResult;
            }
        } else if (typeof this.currentCommand.expectedResult === 'function'){
            consumeBufBytes = this.currentCommand.expectedResult(this.inbuf);
            if (0 < consumeBufBytes){
                finishCommand = true;
            }
        } else {
            throw new Error('Invalid expectedResult for command');
        }


        var consumedBuf;
        if (0 < consumeBufBytes) {
            consumedBuf = this.inbuf.slice(0, consumeBufBytes);
            this.inbuf = this.inbuf.slice(consumeBufBytes);
            DEBUG && console.log("consumed ", consumeBufBytes, "remaining", this.inbuf.toString());
        }
        if (finishCommand){
            // get copy of relevant buffer contents
            // pass relevant in buffer to result handler
            this._serveCommand(this.currentCommand, CommandStateFinished, consumedBuf, matches);

            // matchings for commands might be incorrectly finished such that a newline is forgotten to be added
            // because notifications do not expect there to be an initial newline, trim it away
            this._trimNewlinePrefix();
        }
    }

    // Ideally, if no command was sent we're likely dealing with an unsolicited notification if data is incoming.
    // But due to timing/buffering effects there might be an overlap of a command being registered as running while
    // an unsolicited message is incoming.
    // That means it becomes a bit harder to differentiate between command responses and unsolicited messages - but quite
    // likely this will go unnoticed, as typically command responses and unsolicited messages (even though they might
    // relate to the same info) have slightly different formatting. That also means, that you as a user are responsible
    // for making sure you specify precise enough match phrases.

    while(this._checkForNotifications()){
        // continue trying to consume notifications until there is none detected
    }

    this._setBufferTimeout();
};

Modem.prototype._trimNewlinePrefix = function()
{
    var m = this.inbuf.toString().match(/^((\r|\n)+)/);

    if (m) {
        this.inbuf = this.inbuf.slice(m[0].length);
        return true;
    }

    return false;
}

Modem.prototype._checkForNotifications = function()
{
    var detected = false;

    var str = this.inbuf.toString();
    var line = str.match(this.config.lineRegex);
    if (line){
        // cons¿ole.log("matched a line");
        for (var i in this.notifications){
            var matches = str.match(this.notifications[i].regex);
            // console.log("testing ",str," against ", this.notifications[i].regex);
            if (matches !== null){
                // copy matching buffer

                var buf = this.inbuf.slice(0, matches[0].length);


                // update inbuf consuming matching buffer
                this.inbuf = this.inbuf.slice(matches[0].length);

                // console.log("STRIPPING ",buf, buf.toString());
                // console.log("REMAINING ",this.inbuf, this.inbuf.toString());

                this._serveNotification(this.notifications[i], buf, matches);


                // just for safety, trim any remaining newlines
                this._trimNewlinePrefix();

                detected = true;
                break;
            }
        }

        // this._serveNotification(false, new Buffer(), line);

        // feed notification to generic notification handler
        // if (typeof this.events.notification === 'function'){
        //     this.events.notification(buf);
        // }
    }

    return detected;
};

Modem.prototype._discardLine = function()
{
    var str = this.inbuf.toString();
    var line = str.match(this.config.lineRegex);
    if (line){

        var buf = this.inbuf.slice(0,line[0].length);
        this.inbuf = this.inbuf.slice(line[0].length);

        if (typeof this.events.discarding === 'function'){
            this.events.discarding(buf);
        }

        this._trimNewlinePrefix();

        return true;
    }

    return false;
};

Modem.prototype._setBufferTimeout = function()
{
    this._clearBufferTimeout();

    // do not set timeout, if neither serving a command, nor any data in buffer
    if (!(this.currentCommand instanceof Command) && this.inbuf.length == 0){
        return;
    }

    var timeout = this.config.timeout;
    if (this.currentCommand instanceof Command && typeof this.currentCommand.timeout === 'number'){
        timeout = this.currentCommand.timeout;
    }

    // no timeout if value is zero
    if (timeout == 0){
        return;
    }

    var modem = this;
    this.bufferTimeout = setTimeout(function(){

        // console.log("timeout", modem.inbuf);
        if (modem.currentCommand instanceof Command){
            var command = modem.currentCommand;
            command.result = {
                buf: modem.inbuf
            };
            modem.inbuf = new Buffer(0);
            modem.currentCommand = false;
            command.state = CommandStateTimeout;

            modem._checkPendingCommands();

        } else {

            // if there happen to be unexpected notifications they might block following notifications which we do
            // not necessarily want to discard, so just discard one line at most
            if (modem._discardLine()) {

                if (modem.inbuf.length) {
                    while (modem._checkForNotifications()) {
                        // whilst there are notifications..
                    }
                }
            } else { // if no line detected, discard whole buffer
                var buf = modem.inbuf;
                modem.inbuf = new Buffer(0);

                if (typeof modem.events.discarding === 'function'){
                    modem.events.discarding(buf);
                }
            }
            if (modem.inbuf.length){
                modem._checkPendingCommands();
            }
        }
    }, timeout);
};

Modem.prototype._clearBufferTimeout = function()
{
    if (this.bufferTimeout){
        clearTimeout(this.bufferTimeout);
        this.bufferTimeout = 0;
    }
};

Modem.prototype._serveCommand = function(command, state, buf, matches)
{
    // clear current command
    this.currentCommand = false;

    // set command result
    // command._setResult(buf, matches);
    command.result = {
        buf: buf,
        matches: matches
    };
    if (typeof command.resultProcessor === 'function'){
        command.result.processed = command.resultProcessor(buf, matches);

        // If a result processor is given, but it returns an undefined result, consider the command to have failed
        // thereby any failing commands will be rejected (catched respectively), which is meaningful behaviour
        // note: mostly this will be interesting for simple (string based) commands
        if (typeof command.result.processed === 'undefined'){
            state = CommandStateFailed;
        }
    }

    // by setting the state to a final state, the promise will finish by itself
    command.state = state;

    // feed command to generic command result handler
    if (typeof this.events.command === 'function'){
        this.events.command(command, command.result.processed);
    }

    // console.log("buffer now ", this.inbuf);
    this._checkPendingCommands();
};

Modem.prototype._serveNotification = function(notification, buf, matches)
{
    if (notification instanceof Notification) {
        // feed matches to notification handler (if set)
        if (typeof notification.handler === 'function') {
            notification.handler(buf, matches);
        }
        // feed notification to specific event handler
        if (typeof this.events[notification.name] === 'function') {
            this.events[notification.name](buf, matches);
        }
    } else {
        // feed notification to generic notification handler
        if (typeof this.events.notification === 'function') {
            this.events.notification(matches);
        }
    }
};
