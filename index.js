var Net = require('net'),
    hostname = require("os").hostname(),
    SocksClient = require('socks').SocksClient;

var ZabbixSender = module.exports = function (opts) {
    opts = (typeof opts !== 'undefined') ? opts : {};

    this.host = opts.host || 'localhost';
    this.port = parseInt(opts.port) || 10051;
    this.timeout = parseInt(opts.timeout) || 5000;
    this.with_ns = opts.with_ns || false;
    this.with_timestamps = this.with_ns || opts.with_timestamps || false;
    this.items_host = opts.items_host || hostname;
    this.proxy = opts.proxy;

    // prepare items array
    this.clearItems();
}

ZabbixSender.prototype.addItem = function (host, key, value) {
    if (arguments.length < 3) {
        if (arguments.length < 2) {
            throw new Error('addItem requires 2 or 3 arguments');
        }

        // if just 2 args provided
        value = key;
        key = host;
        host = this.items_host;
    }

    var length = this.items.push({
        host: host,
        key: key,
        value: value
    });

    if (this.with_timestamps) {
        var ts = Date.now() / 1000;
        this.items[length - 1].clock = ts | 0;

        if (this.with_ns) {
            this.items[length - 1].ns = (ts % 1) * 1000 * 1000000 | 0;
        }
    }

    return this;
}

ZabbixSender.prototype.clearItems = function () {
    this.items = [];
    return this;
}

ZabbixSender.prototype.countItems = function () {
    return this.items.length;
}

ZabbixSender.prototype.send = function (callback) {
    // make sure callback is a function
    callback = (typeof callback === 'function') ? callback : function () {
    };

    var self = this,
        error = false,
        items = this.items,
        data = prepareData(items, this.with_timestamps, this.with_ns),
        client,
        response = Buffer.alloc(0);

    function onData(data) {
        response = Buffer.concat([response, data]);
    }

    function onError(err) {
        error = err;
    }

    function onClose() {
        // bail out on any error
        if (error) {
            // in case of error, put the items back
            self.items = self.items.concat(items);
            return callback(error, {});
        }

        if (response.length === 0) {
            // Zabbix server closed the connection with no response
            // That might happen if the server is not active in a cluster
            return callback(new Error('got empty response from server'), {});
        }

        // bail out if got wrong response
        if (response.slice(0, 5).toString() !== 'ZBXD\x01') {
            // in case of bad response, put the items back
            self.items = self.items.concat(items);
            return callback(new Error("got invalid response from server"), {});
        }

        // all clear, return the result
        callback(null, JSON.parse(response.slice(13)), items);
    }

    // uncoment when debugging
    //console.log(data.slice(13).toString());

    // reset items array
    this.clearItems();

    if (this.proxy) {
        SocksClient.createConnection({
            proxy: this.proxy,
            command: 'connect',
            destination: {
                host: this.host,
                port: this.port
            },
            timeout: this.timeout
        }).then((info) => {
            const client = info.socket;
            client.on('data', onData);
            client.on('error', onError);
            client.on('close', onClose);
            client.write(data);
        }).catch(callback);
    } else {
        client = new Net.Socket();

        // set socket timeout
        client.setTimeout(this.timeout);

        client.connect(this.port, this.host, function () {
            client.write(data);
        });

        client.on('data', onData);

        client.on('timeout', function () {
            error = new Error("socket timed out after " + self.timeout / 1000 + " seconds");
            client.destroy();
        });

        client.on('error', onError);

        client.on('close', onClose);
    }
}

// takes items array and prepares payload for sending
function prepareData(items, with_timestamps, with_ns) {
    var data = {
        request: 'sender data',
        data: items
    };

    if (with_timestamps) {
        var ts = Date.now() / 1000;
        data.clock = ts | 0;

        if (with_ns) {
            data.ns = (ts % 1) * 1000 * 1000000 | 0;
        }
    }

    var payload = Buffer.from(JSON.stringify(data), 'utf8'),
        header = Buffer.alloc(5 + 4); // ZBXD\1 + packed payload.length

    header.write('ZBXD\x01');
    header.writeInt32LE(payload.length, 5);
    return Buffer.concat([header, Buffer.from('\x00\x00\x00\x00'), payload]);
}
