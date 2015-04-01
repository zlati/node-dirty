var fs = require('fs');
var filelog = fs.createWriteStream('alerts.txt', {'flags': 'a'});
var logger = require('util');
var crypto = require('crypto');
var Entities = require('html-entities').AllHtmlEntities;
var _ = require('underscore')._;
var html_entities = new Entities();
var soap;
var db_pings;
var db_status;
var db_status_group;
var db_alerts;
var db_mailinglist;
var db_posts;
var db_settings;
var mysettings;
var settings_groups = [];
var settings_pools = {};
var settings_suvi_pools = {};
var pool_status_changed_queue;
var pool_status_changed_queue_interval  = false;
var alert_mail_queue;
var alert_mail_queue_interval = false;
var lastService = {};
var pg = require('pg');
var EventEmitter = require('events').EventEmitter;
var sys = require('util');

pad = function (n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

exports.create = function (api, settings) {
     
    mysettings = settings;
    if (settings.plugins && settings.plugins.alertSoap && settings.plugins.alertSoap.enable) {
        logger.log('Creating the plugin: ' + __filename);

        if (settings.plugins.alertSoap.groups) {
            settings_groups = settings.plugins.alertSoap.groups;
        }
        if (settings.plugins.alertSoap.pools) {
            settings_pools = settings.plugins.alertSoap.pools;
        }
        if (settings.plugins.alertSoap.suvi_pools) {
            settings_suvi_pools = settings.plugins.alertSoap.suvi_pools;
        }


        var d = new Date();
        monthly_file = d.getFullYear() + '' + (d.getMonth() + 1);
        logger.log('Using Dirty  db : alertsoap_' + monthly_file + '_*.db');
        db_pings = require('dirty')('alertsoap_' + monthly_file + '_pings');
        db_status = require('dirty')('alertsoap_' + monthly_file + '_status');
        db_status_group = require('dirty')('alertsoap_' + monthly_file + '_status_group');
        db_alerts = require('dirty')('alertsoap_' + monthly_file + '_alerts');
        used_dbs = 4;
        db_mailinglist = require('dirty')('alertsoap_mailinglist');
        db_posts = require('dirty')('alertsoap_posts');
        used_dbs = 6;
        db_settings = require('dirty')('alertsoap_settings');
        used_dbs = 7;
        pool_status_changed_queue = require('dirty')();
        alert_mail_queue = require('dirty')();

        soap = require('soap');
        var fs = require('fs');
        //Zeus SOAP
        var xml = fs.readFileSync(__dirname + '/AlertCallback.wsdl', 'utf8');
        var service = {
            AlertCallback: {
                AlertCallbackPort: {
                    eventOccurred: function (args, callback) {
                        if (settings.plugins.alertSoap.key) {
                            if (args.additional == settings.plugins.alertSoap.key) {
                                //unset(args.additional);
                                sortSoap(args);
                            }
                        } else {
                            sortSoap(args);
                        }
                        return {
                            additional: args.additional
                        };
                    }
                }
            }
        }

        var db_loaded = 0;
        db_pings.on('load', function (length) {
            if (!db_pings.get("zxtm")) {
                db_pings.set("zxtm", new Date().valueOf());
                db_pings.set("suvi", new Date().valueOf());
            }
            dbLoaded(db_pings);
        });
        db_status.on('load', function (length) {
            dbLoaded(db_status);
        });
        db_status_group.on('load', function (length) {
            db_status_group.forEach(function (key, val) {
                db_status_group.rm(key);
            });
            //Add all defined groups
            for (i in settings_groups) {
                var struct = db_status_group.get(settings_groups[i]);
                if (typeof (struct) == 'undefined') {
                    struct = {
                        groupName: settings_groups[i],
                        status: 0,
                        pools: new Object()
                    };
                    db_status_group.set(settings_groups[i], struct);
                }
            }
            dbLoaded(db_status_group);
        });
        db_alerts.on('load', function (length) {
            dbLoaded(db_alerts);
        });
        db_mailinglist.on('load', function (length) {
            dbLoaded(db_mailinglist);
        });
        db_posts.on('load', function (length) {
            dbLoaded(db_posts);
        });
        db_settings.on('load', function (length) {
            dbLoaded(db_settings);
        });
        dbCompact = function (db) {
            if (db.compacting)
                return;
            if (db.length * 3 < db.redundantLength) {
                logger.log('redundant:' + db.redundantLength + ': ' + db.path);
                db.compact();
            }
        }

        dbLoaded = function (db) {
            dbCompact(db);
            db.on('compacted', function () {
                logger.log('compact OK:' + db.length + ': ' + db.path);
            });
            db.on('compactingError', function () {
                logger.log('compact ERR: ' + db.path);
            });

            db_loaded++;
            logger.log('Done loading db:' + db_loaded);
            if (!db.get("created")) {
                db.set("created", new Date().valueOf());
                db.set("created-plain", new Date().toString());
            }
            if (db_loaded == used_dbs) {
                parseAlerts();
                parseStatus();
                soap.listen(api.getServer(), '/alertSoap', service, xml);
                logger.log('Soap listening on /alertSoap');
            }
        }

        sortSoap = function (args) {
            var date = new Date().valueOf();
            if (d.getFullYear() + '' + (d.getMonth() + 1) != monthly_file) {
                logger.log('New month, restart server');
                process.exit();
            }

            if (args.event_type == 'Soap ping') {
                if (args.zxtm == 'SUVI') {
                    logger.log('Got ping suvi');
                    db_pings.set('suvi', date);
                } else {
                    logger.log('Got ping zxtm');
                    db_pings.set('zxtm', date);
                }
                dbCompact(db_pings);
                api.emit('updatePing');
            } else {
                filelog.write(JSON.stringify(args) + "\n\n");
                if (args.zxtm == 'SUVI') {
                    logger.log('Got suvi alert');
                } else if (args.zxtm == 'PLANNED') {
                    logger.log('Got planned alert');
                    args.objects.item.push({
                        time: date
                    });
                    newPost(args.objects.item[0].name, args.objects.item);
                    return;
                } else if (args.zxtm == 'dotcloud') {
                    logger.log('Got local alert');
                } else {
                    logger.log('Got zxtm alert');
                    args.time = new Date(args.time).getTime();
                }
                args.timeReadable = new Date(args.time).toISOString();
                if (args.event_type == 'tt_up' || args.event_type == 'tt_down') {
                    db_pings.set('tt_alert', date);
                }

                //Increase key if already used so we get unique alert keys
                if (typeof (db_alerts.get(date)) !== 'undefined') {
                    date++;
                }
                db_alerts.set(date, args);
                parseAlerts(date);
                parseAlerts();
                parseStatus();
                api.emit("newAlert");
            }
        }

        parsePoolFromAlert = function (val) {
            var pool = "";
            if (val.zxtm == 'SUVI') {
                val.objects.Item = val.objects.item;
                pool = "ignore";
                if (settings_suvi_pools[val.objects.Item[1].name + ':' + val.objects.Item[0].name]) {
                    pool = settings_suvi_pools[val.objects.Item[1].name + ':' + val.objects.Item[0].name];
                } else if (settings_suvi_pools[val.objects.Item[1].name.slice(0, -1) + ':' + val.objects.Item[0].name]) {
                    pool = settings_suvi_pools[val.objects.Item[1].name.slice(0, -1) + ':' + val.objects.Item[0].name];
                } else if (settings_suvi_pools[val.objects.Item[1].name.slice(0, -2) + ':' + val.objects.Item[0].name]) {
                    pool = settings_suvi_pools[val.objects.Item[1].name.slice(0, -2) + ':' + val.objects.Item[0].name];
                }
            } else {
                if (Array.isArray(val.objects.Item)) {
                    pool = val.objects.Item[0].name;
                } else {
                    pool = val.objects.Item.name;
                }
                pool = pool.replace("11_pool_", "").replace("12_pool_", "").replace("19_pool_", "").replace("pool_", "");
            }
            return pool;
        }

        parseStatus = function (in_key) {
            if (typeof (in_key) == 'undefined') {
                db_status.forEach(function (key, val) {
                    parseStatusLoop(key, val);
                });
            } else {
                parseStatusLoop(in_key);
            }
            dbCompact(db_status_group);

        }

        /**
         * Uppdaterar motsvarande status group med information från angiven status
         */
        parseStatusLoop = function (key, val) {
            if (key == 'created' || key == 'created-plain') {
                return;
            }
            if (typeof (val) == 'undefined') {
                val = db_status.get(key);
            }

            if (typeof (settings_pools[key]) == 'undefined') {
                var pool_key = 'Övriga';
                var pool_name = key;
            } else {
                var pool_key = settings_pools[key].group;
                var pool_name = settings_pools[key].name;
            }
            if (typeof (pool_key) == 'undefined') {
                return;
            }

            //Get group
            var struct = db_status_group.get(pool_key);

            //If group isnt set then its disabled ignore the status
            if (typeof (struct) == 'undefined') {
                return;
            }

            struct.groupName = pool_key;

            //Update pool status with current pool status
            struct.pools[key] = val.global + val.host_max;

            //Set status to max status for pools
            struct.status = 0;
            for (i in struct.pools) {
                if (struct.pools[i] > struct.status) {
                    struct.status = struct.pools[i];
                }
            }
            db_status_group.set(pool_key, struct);
        }

        parseAlerts = function (in_key) {
            if (typeof (in_key) == 'undefined') {
                for (pool in settings_pools) {
                    struct = db_status.get(pool);
                    if (typeof (struct) == 'undefined') {
                        struct = {"suvi": {
                                global: 0,
                                host_max: 0,
                                hosts: new Object(),
                                log: []
                            }, "dotcloud": {
                                global: 0,
                                host_max: 0,
                                hosts: new Object(),
                                log: []
                            }, "zeus": {
                                global: 0,
                                host_max: 0,
                                hosts: new Object(),
                                log: []
                            },
                            global: 0,
                            host_max: 0,
                            log: []};
                        db_status.set(pool, struct);
                    }
                }
                db_status.forEach(function (key, val) {
                    if (key == 'created' || key == 'created-plain') {
                        return;
                    }
                    if (key == 'ignore') {
                        db_status.rm(key);
                        return;
                    }
                    val.suvi.log = [];
                    val.dotcloud.log = [];
                    val.zeus.log = [];
                    val.log = [];
                    db_status.set(key, val);
                });
                db_alerts.forEach(function (key, val) {
                    parseAlertsLoop(key, val);
                });
            } else {
                parseAlertsLoop(in_key);
            }
            dbCompact(db_status);
        }

        /**
         * When removing alerts, rollback the last event time also
         */
        rmAlert = function (key) {
            logger.log("removing alert: " + key);
            db_alerts.rm(key);
            var last_alert = 0;
            db_alerts.forEach(function (key, val) {
                if (val.time > last_alert) {
                    last_alert = val.time;
                }
            });
            if (last_alert == 0) {
                db_pings.rm('server_alert');
            } else {
                db_pings.set('server_alert', last_alert);
            }
        };

        /**
         * Remove events saved for rollback
         */
        removeRollback = function (pool) {
            logger.log("removeRollback");
            logger.log(pool);
            var struct = db_status.get(pool);
            if (Array.isArray(struct.last_events)) {
                delete struct.last_events;
            }
            db_status.set(pool, struct);
        };

        /**
         * Perform rollback of recent events
         */
        doRollback = function (pool) {
            logger.log("doRollback");
            logger.log(pool);
            var struct = db_status.get(pool);
            if (Array.isArray(struct.last_events)) {
                for (i in struct.last_events) {
                    logger.log("removing");
                    logger.log(struct.last_events[i]);
                    rmAlert(struct.last_events[i]);
                }
                delete struct.last_events;
            }
            db_status.set(pool, struct);
        };

        /**
         * Uppdaterar motsvarande status object med information från angiven alert
         */
        parseAlertsLoop = function (key, val) {
            if (key == 'created' || key == 'created-plain') {
                return;
            }
            var updateStatus = false;
            if (typeof (val) == 'undefined') {
                val = db_alerts.get(key);
                updateStatus = true;
            }
            var ignore = false;
            var ip_regexp = patt = /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/;
            switch (val.primary_tag) {
                case 'pools_pooldied':
                    scope = 'global';
                    error = 2;
                    type = 1;
                    break;
                case 'pools_poolok':
                    scope = 'global';
                    error = 0;
                    type = 1;
                    break;
                case 'pools_nodeworking':
                    scope = ip_regexp.exec(val.description);
                    error = 0;
                    type = 2;
                    break;
                case 'pools_nodefail':
                    scope = ip_regexp.exec(val.description);
                    error = 1;
                    type = 2;
                    break;
                case 'monitors_monitorok':
                case 'monitors_monitorfail':
                case 'vservers_vsstop':
                case 'vservers_vsstart':
                case 'faulttolerance_machinefail':
                case 'faulttolerance_machineok':
                    ignore = true;
                    break;
                default:
                    logger.log(JSON.stringify(["ignoring", val.primary_tag, val]));
                    ignore = true;
                    break;
            }
            var zxtm_key = null;
            var zxtm_key_short = null;
            switch (val.zxtm) {
                case 'SUVI':
                    zxtm_key = 'suvi';
                    zxtm_key_short = 'S: ';
                    break;
                case 'dotcloud':
                    zxtm_key = 'dotcloud';
                    zxtm_key_short = 'D: ';
                    break;
                default:
                    zxtm_key = 'zeus';
                    zxtm_key_short = 'Z: ';
                    break;
            }
            if (ignore) {
                rmAlert(key);
                return;
            }

            var description = val.description.replace('192.168.0.', 'xxx.xxx.xxx.').replace('172.16.32.', 'yyy.yyy.yyy.').replace('10.164.', 'zzz.zzz.');
            //Remove monitor part of error description
            if (description.indexOf(' -') > 0) {
                description = description.substr(0, description.indexOf(' -'));
            }

            if (typeof (val.pool) == 'undefined') {
                var pool = parsePoolFromAlert(val);
            } else {
                var pool = val.pool;
            }
            var struct = db_status.get(pool);

            //Not defined in pool
            if (typeof (struct) == 'undefined') {
                logger.log('Ignoring alert for pool:' + pool);
                rmAlert(key);
                return;
            }

            //Save previous status, so we can check if the status changed
            var status_before = struct[zxtm_key].global + struct[zxtm_key].host_max;
            /*
             status_before:
             0: OK
             1: node failed
             2: global failed
             3: node and global failed
             */
            if (scope == 'global') {
                //Global status didnt change then this is a dupe event
                if (updateStatus && struct[zxtm_key].global == error) {
                    if (updateStatus) {
                        logger.log("dupe");
                        logger.log(pool);
                        logger.log(struct[zxtm_key].global);
                        logger.log(error);
                        logger.log(key);
                        rmAlert(key);
                        logger.log("--dupe--");
                    }
                    return;
                } else if (updateStatus) {
                    logger.log("not dupe");
                    logger.log(pool);
                    logger.log(struct[zxtm_key].global);
                    logger.log(error);
                    logger.log(key);
                    logger.log("--not dupe--");
                }
                struct[zxtm_key].global = error;
            } else {
                if (!struct[zxtm_key].hosts.hasOwnProperty(scope)) {
                    struct[zxtm_key].hosts[scope] = error;
                    logger.log("new host");
                    logger.log(scope);
                    logger.log(struct[zxtm_key].hosts[scope]);
                    logger.log(error);
                    logger.log(key);
                    logger.log("--new host--");
                } else if (updateStatus && struct[zxtm_key].hosts[scope] == error) {
                    //Host status didnt change then this is a dupe event
                    if (updateStatus) {
                        logger.log("dupe");
                        logger.log(scope);
                        logger.log(struct[zxtm_key].hosts[scope]);
                        logger.log(error);
                        logger.log(key);
                        logger.log("--dupe--");
                        rmAlert(key);
                    }
                    return;
                } else if (updateStatus) {
                    logger.log("not dupe");
                    logger.log(scope);
                    logger.log(struct[zxtm_key].hosts[scope]);
                    logger.log(error);
                    logger.log(key);
                    logger.log("--not dupe--");
                }
                struct[zxtm_key].hosts[scope] = error;
                struct[zxtm_key].host_max = 0;
                for (i in struct[zxtm_key].hosts) {
                    if (struct[zxtm_key].host_max < struct[zxtm_key].hosts[i]) {
                        struct[zxtm_key].host_max = struct[zxtm_key].hosts[i];
                    }
                }
                //If no host is down, then global should be up also
                if (struct[zxtm_key].host_max == 0) {
                    struct[zxtm_key].global = 0;
                }
            }

            if (scope == 'global') {
                if (error) {
                    error = 2;
                } else {
                    error = 0;
                }
            }

            struct[zxtm_key].log.push({
                error: error,
                time: key,
                desc: description,
                scope: scope
            });

            struct.log.push({
                error: error,
                time: key,
                desc: zxtm_key_short + description,
                scope: scope
            });

            //Merge status to global
            struct.host_max = Math.max(struct.suvi.host_max, struct.dotcloud.host_max, struct.zeus.host_max);
            struct.global = Math.max(struct.suvi.global, struct.dotcloud.global, struct.zeus.global);

            if (updateStatus) {
                //If the previous status was OK then create last events array
                if (!Array.isArray(struct.last_events) && status_before == 0) {
                    struct.last_events = [];
                }
                //Add key of event, for rollback if last_events array has been created
                if (Array.isArray(struct.last_events)) {
                    struct.last_events.push(key);
                }

                db_status.set(pool, struct);

                logger.log("updateStatus");
                logger.log("pool:" + pool);
                logger.log("key:" + key);
                logger.log("global:" + struct.global);
                logger.log("host_max:" + struct.host_max);
                logger.log("status_before:" + status_before);
                logger.log("--updateStatus--");
                //Delay down message 6 minutes, and if the pool comes up before announce delete the down time
                if (struct[zxtm_key].global + struct[zxtm_key].host_max != status_before) {
                    if (typeof (pool_status_changed_queue.get(pool)) === 'undefined') {
                        //Queue pool failure
                        var pool_queue = [];
                        pool_queue.push({key: key, time: new Date().getTime(), pool: pool, error: error});
                        pool_status_changed_queue.set(pool, pool_queue);
                    } else {
                        var pool_queue = pool_status_changed_queue.get(pool);
                        pool_queue.push({key: key, time: new Date().getTime(), pool: pool, error: error});
                        pool_status_changed_queue.set(pool, pool_queue);
                    }
                    if (status_before == 0 || struct[zxtm_key].global + struct[zxtm_key].host_max != 0) {
                        logger.log("pool/node down");
                        //Pool down
                        db_pings.set('server_alert', key);
                        if (pool_status_changed_queue_interval === false) {
                            logger.log("starting pool status change queue");
                            pool_status_changed_queue_interval = setInterval(function () {
                                logger.log("down 5 minutes check");
                                //Check for queued failures happening 5 minutes ago
                                var interval_time = new Date().getTime();
                                var status_queue_empty = true;
                                pool_status_changed_queue.forEach(function (key, vals) {
                                    status_queue_empty = false;
                                    var status_queue_emit = false;
                                    var index;
                                    var val;
                                    for (index = 0; index < vals.length; ++index) {
                                        val = vals[index];
                                        if (interval_time > val.time + 5 * 60) {
                                            status_queue_emit = true;
                                        }
                                    }
                                    //Pool has been down for 5 minutes send notice
                                    if (status_queue_emit) {
                                        for (index = 0; index < vals.length; ++index) {
                                            val = vals[index];
                                            logger.log([val.pool, val.error]);
                                            api.emit('poolStatusChanged', val.pool, val.error);
                                        }
                                        logger.log("emitting " + key);
                                        pool_status_changed_queue.rm(key);
                                        //Since we output an event, remove the possiblity to rollback any events for this pool that happened before this event(including this event)
                                        logger.log("no rollback left");
                                        removeRollback(key);
                                    }
                                });
                                if (status_queue_empty) {
                                    logger.log("stopping pool status change queue");
                                    clearInterval(pool_status_changed_queue_interval);
                                    pool_status_changed_queue_interval = false;
                                }
                            }, 60 * 6 * 1000);
                        }
                    } else {
                        logger.log("pool up");
                        //Pool up
                        if (typeof (pool_status_changed_queue.get(pool)) !== 'undefined') {
                            //Pool up before interval elapsed, remove down and up notice and remove down notice from queue
                            doRollback(pool);
                            pool_status_changed_queue.rm(pool);
                        }
                        api.emit('poolStatusChanged', pool, error);
                    }
                } else if (status_before == 0) {
                    logger.log("ok ok");
                    //If status before was OK and it's still ok, remove the ok from the alerts db
                    doRollback(pool);
                }
            } else {
                db_status.set(pool, struct);
            }
            parseStatus(pool);
        }

        api.on('up', function (service) {
            checkChangesAlert(service);
        });

        api.on('down', function (service) {
            checkChangesAlert(service);
        });

        api.on('unknown', function (service) {
            checkChangesAlert(service);
        });

        api.on('critical', function (service) {
            checkChangesAlert(service);
        });

        api.on('poolStatusChanged', function (pool, error) {
            if (typeof (settings_pools[pool]) == 'undefined') {
                return;
            }
            var name = settings_pools[pool].name;
            var group = settings_pools[pool].group;

            //Skicka inte mail om övriga gruppen
            if (group == 'Övriga') {
                return;
            }
            var type = "";
            switch (error) {
                case 0:
                    type = "Uppe";
                    break;
                case 1:
                    type = "Varning";
                    //Skicka inte mail om varningar
                    return;
                    break;
                case 2:
                    type = "Nere";
                    break;
            }

            alert_mail_queue.set(name, group + '(' + name + '): ' + type);
            if (alert_mail_queue_interval === false) {
                alert_mail_queue_interval = setInterval(function () {
                    var alert_mail_queue_empty = true;
                    var alert_mail_queue_array = [];
                    alert_mail_queue.forEach(function (key, val) {
                        alert_mail_queue_empty = false;
                        alert_mail_queue.rm(key);
                        alert_mail_queue_array.push(val);
                    });

                    if (alert_mail_queue_empty) {
                        clearInterval(alert_mail_queue_interval);
                        alert_mail_queue_interval = false;
                    } else {
                        db_mailinglist.forEach(function (key, val) {
                            api.emit('sendMail', "<pre>" + alert_mail_queue_array.join('\n') + "</pre>", val.email, 'Driftinfo PA Kompetens');
                        });
                    }
                }, 30 * 1000);
            }
        });

        api.on('sendLastPing', function (socket) {
            var suvi = db_pings.get('suvi');
            var zxtm = db_pings.get('zxtm');
            var alert = db_pings.get('server_alert');
            var time = zxtm;

            //If alert is the oldest, return the oldest ping instead, this allows use to give any alert since the last ping as the last event
            if (suvi < zxtm) {
                time = suvi;
            }
            if (alert > time) {
                time = alert;
            }
            console.log('sendLastPing');

            socket.emit('lastPing', {
                time: time,
                str: api.get_uptime(time)
            });
        });

        api.on('sendLastAlert', function (socket) {

            var alert = db_pings.get('server_alert');
            if (typeof (alert) == 'undefined') {
                socket.emit('lastAlert', {
                    time: '',
                    str: 'Ingen långvarig händelse denna månad'
                });
            } else {
                socket.emit('lastAlert', {
                    time: alert,
                    str: api.get_uptime(alert)
                });
            }
            console.log('after2');

        });

        /*
         api.on('getDump',function(socket){
         api.on('getDump',function(socket){do
         socket.emit('dumpGot',db_pings.get('zxtm')+':'+db_pings.get('suvi'));
         });
         
         api.on('sendAlerts',function(socket){
         var i = 0;
         db_alerts.forEach(function(key, val) {
         if(key=='created' || key=='created-plain') {
         return;
         }
         var date = new Date(Date.parse(val.time));
         val.time = date.valueOf();
         if(val.zxtm) {
         socket.emit('listAlerts',val);
         i++;
         }
         if(i>5) {
         return false;
         }
         });
         });
         */

        api.on('sendAlertEvents', function (socket, pool) {
            var pool_array = [];
            if (pool == null) {
                db_status.forEach(function (key, val) {
                    if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                        return;
                    }
                    pool_array.push(key);
                });
                pool_array.sort();
            } else {
                for (i in settings_pools) {
                    if (settings_pools[i].name == pool) {
                        var struct = db_status.get(i);
                        if (typeof (struct) != 'undefined') {
                            pool_array.push(i);
                        }
                    }
                }
            }

            var alerts = [];
            for (i in pool_array) {
                var val = db_status.get(pool_array[i]);
                var val_log = val.log;
                delete val.log;
                delete val["SUVI"];
                delete val["dotcloud"];
                delete val["zeus"];
                alerts.push({
                    type: 'pool',
                    pool: settings_pools[pool_array[i]].name,
                    val: val
                });
                var log_array = [];
                for (j in val_log) {
                    val_log[j].type = 'event';
                    alerts.push(val_log[j]);
                }

            }
            socket.emit('listAlertEvents', alerts);
            api.emit("sendLastAlert", socket);
            api.emit("sendLastPing", socket);
        });

        api.on('sendPoolAlerts', function (socket, group) {
            var group_array = [];
            if (group == null) {
                db_status_group.forEach(function (key, val) {
                    if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                        return;
                    }
                    group_array.push(key);
                });
                group_array.sort();
            } else {
                var struct = db_status_group.get(group);
                if (typeof (struct) != 'undefined') {
                    group_array.push(group);
                }
            }

            var alerts = [];
            for (i in group_array) {
                var val = db_status_group.get(group_array[i]);
                alerts.push({
                    type: 'group',
                    val: val
                });
                var pool_alerts = [];
                for (j in val.pools) {
                    struct = db_status.get(j);
                    if (typeof struct.log.length == "undefined") {
                        struct.log = 0;
                    }
                    else {
                        struct.log = struct.log.length;
                    }
                    delete struct["SUVI"];
                    delete struct["dotcloud"];
                    delete struct["zeus"];
                    var name = "";
                    if (typeof (settings_pools[j]) == 'undefined') {
                        name = j;
                    } else {
                        name = settings_pools[j].name;
                    }
                    pool_alerts.push({
                        type: 'pool',
                        pool: name,
                        val: struct
                    });
                }
                pool_alerts.sort(function (a, b) {
                    if (a.pool < b.pool) {
                        return -1;
                    }
                    return 1;
                });
                //pool_alerts.reverse();
                for (i in pool_alerts) {
                    alerts.push(pool_alerts[i]);
                }
            }
            //logger.log(alerts);
            //console.log('a', alerts);
            socket.emit('listPoolAlerts', alerts);
            api.emit("sendLastAlert", socket);
            api.emit("sendLastPing", socket);
            group_array.length = 0;
            logger.log("sendPoolAlerts");
        });

        api.on('sendGroupAlerts', function (socket) {
            var group_array = [];
            logger.log("db_status_group");
            db_status_group.forEach(function (key, val) {
                if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                    return;
                }
                logger.log(key);
                group_array.push(key);
            });

            group_array.sort();
            var alerts = [];
            for (i in group_array) {
                var val = JSON.parse(JSON.stringify(db_status_group.get(group_array[i])));
                for (j in val.pools) {
                    if (val.pools[j] != 0) {
                        val.pools[j] = {status: val.pools[j], name: settings_pools[j].name};
                    } else {
                        delete val.pools[j];
                    }
                }
                alerts.push(val);
            }
            socket.emit('listGroupAlerts', alerts);
            api.emit("sendLastAlert", socket);
            api.emit("sendLastPing", socket);
            group_array.length = 0;
        });

        api.on('sendLoggedIn', function (socket) {
            var group_array = [];
            logger.log("sendLoggedIn " + socket.id);
            db_status_group.forEach(function (key, val) {
                if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                    return;
                }
                logger.log(key);
                group_array.push(key);
            });
            group_array.sort();

            var alerts = [];
            for (i in group_array) {
                var val = JSON.parse(JSON.stringify(db_status_group.get(group_array[i])));
                for (j in val.pools) {
                    if (val.pools[j] != 0) {
                        val.pools[j] = {status: val.pools[j], name: settings_pools[j].name};
                    } else {
                        delete val.pools[j];
                    }
                }
                if (Object.keys(val.pools).length > 0) {
                    alerts.push(val);
                }
            }
            group_array.length = 0;

            var failsafe_rdp_active = db_settings.get('failsafe_rdp');
            logger.log("failsafe_rdp_active ");
            logger.log(logger.inspect(failsafe_rdp_active));
            if (typeof (failsafe_rdp_active) == 'undefined') {
                failsafe_rdp_active = false;
            }
            socket.emit('listLoggedIn', {alertGroups: alerts, settings:
                        [
                            {id: 'failsafe_rdp', name: 'Felsäkert Fjärrskrivbord', active: failsafe_rdp_active}
                        ]
            });
        });

        api.on('sendMonth', function (socket) {
            logger.log('sendMonth');
            socket.emit('listMonth', monthly_file);
        });

        api.on('sendNews', function (socket) {
            logger.log('sendNews');
            var d = new Date();
            var month_start = new Date(d.getFullYear(), d.getMonth(), 1).getTime() - 24 * 60 * 60;
            var news = [];
            db_posts.forEach(function (key, val) {
                if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                    return;
                }
                //News from last month and older then 7 days, delete
                if (val[4].time < month_start && val[4].time < (d - 7 * 24 * 60 * 60)) {
                    db_posts.rm(key);
                    return;
                }
                news.push({
                    time: val[4].time,
                    subject: val[2].name,
                    msg: val[3].name
                });
            });
            news.sort(function (a, b) {
                if (a.time > b.time) {
                    return -1;
                }
                return 1;
            });

            var failsafe_rdp_active = db_settings.get('failsafe_rdp');
            if (typeof (failsafe_rdp_active) != 'undefined') {
                var str = d.getFullYear() + "" + pad(d.getMonth() + 1, 2) + "" + d.getDate();
                key1 = crypto.createHash('sha512').update(str + settings.plugins.alertSoap.key).digest("hex");
                key2 = crypto.createHash('sha512').update("failsafe" + key1).digest("hex");

                news.unshift({
                    time: d.getTime(),
                    subject: 'Test Felsäkertläge',
                    msg: 'För närvarande är där störningar som påverkar fjärrskrivbordet, undertiden dessa störningar felsökes har alla användare begränsats till en enklare miljö.<br>Detta så att ni skall kunna fortsätta arbeta.<br><a target="_blank" href="https://rdp.webkontor.nu/?key=' + key2 + '">Logga in på fjärrskrivbordet</a>'
                });


            }

            socket.emit('listNews', news);
            logger.log('newsListed');
            dbCompact(db_posts);
        });


        api.on('doChangeSetting', function (socket, settingName) {
            logger.log("doChangeSetting");
            logger.log("doChangeSetting " + settingName);
            var setting = db_settings.get(settingName);
            if (typeof (setting) == 'undefined') {
                logger.log("doChangeSetting true");
                db_settings.set(settingName, true);
            } else {
                logger.log("doChangeSetting false");
                db_settings.rm(settingName);
            }
            api.emit("newAlert");
            api.emit("newNews");
        });

        api.on('doResetPoolEvents', function (socket, pool) {
            logger.log("doResetPoolEvents");
            var struct = db_status.get(pool);
            var triggerTime = new Date().getTime();

            for (var type in struct) {
                if (struct[type].host_max > 0) {
                    for (var host in struct[type].hosts) {
                        if (struct[type].hosts[host] > 0) {
                            var checkObj = {};
                            checkObj.zxtm = type;
                            checkObj.pool = pool;
                            checkObj.time = triggerTime;
                            checkObj.primary_tag = 'pools_nodeworking';
                            checkObj.description = 'Manuellt OK';
                            checkObj.objects = {"Item": [{"type": "pools", "name": pool}, {"type": "nodes", "name": host}]}
                            sortSoap(checkObj);
                        }
                    }
                }
                if (struct[type].global > 0) {
                    var checkObj = {};
                    checkObj.zxtm = type;
                    checkObj.pool = pool;
                    checkObj.time = triggerTime;
                    checkObj.primary_tag = 'pools_poolok';
                    checkObj.description = 'Manuellt OK';
                    sortSoap(checkObj);
                }
            }
        });

        api.on('imapPollNewMail', function (mail) {
            switch (mail.headers.to) {
                case "pa.drift@gmail.com":
                    adminAction(mail);
                    break;
                case "pa.dri.ft@gmail.com":
                    if (process.env.DOTCLOUD_PROJECT != 'driftinfo') {
                        adminAction(mail);
                    }
                    break;
                default:
                    subscribeAction(mail);
                    break;
            }
        });

        adminAction = function (mail) {
            var subject = mail.headers.subject;
            if (subject.indexOf('drift:') === 0) {
                args = subject.split(':', 4);
                logger.log(JSON.stringify(args));
                var key = '';
                logger.log('adminAction:' + args[1].trim());
                switch (args[1].trim()) {
                    case 'help':
                        api.emit('sendMail', 'Rubrik kommandon:<br />\
drift:help - Denna hjälp<br />\
drift:list - Listar alla poster som finns med nykel samt rubrik<br />\
drift:listalerts - Listar alla alerts som finns lagrade i ordning<br />\
drift:del:&lt;nykel&gt; - Tar bort posten med angiven nykel<br />\
drift:&lt;nykel&gt;: - Uppdaterar angiven post med ny rubrik/text tagen från mailet<br />\
drift: - Skapar en ny post med rubrik/text tagen från mailet', mail.headers.from, 'Admin:help');
                        break;
                    case 'listalerts':
                        logger.log('listalerts');
                        var alerts = {};
                        db_alerts.forEach(function (key, val) {
                            if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                                return;
                            }
                            if (typeof (parsePoolFromAlert(val)) == 'undefined') {
                                logger.log(val);
                            } else {
                                if (typeof (alerts[parsePoolFromAlert(val)]) == 'undefined') {
                                    alerts[parsePoolFromAlert(val)] = {};
                                }
                                alerts[parsePoolFromAlert(val)][key] = {"time": val.time, "zxtm": val.zxtm, "severity": val.severity, "primary_tag": val.primary_tag, "objects": val.objects};
                            }
                        });
                        var alerts_array = [];
                        var sorted_pools = _.keys(alerts).sort();
                        for (pool in sorted_pools) {
                            pool = sorted_pools[pool];
                            alerts_array.push("");
                            alerts_array.push(pool);
                            var sorted_keys = Object.keys(alerts[pool]).sort();
                            for (k in sorted_keys) {
                                alerts_array.push(JSON.stringify(alerts[pool][sorted_keys[k]]));
                            }
                        }
                        api.emit('sendMail', 'Aktuella alerts:<br />' + alerts_array.join('<br />'), mail.headers.from, 'Admin:listalerts');
                        break;
                    case 'list':
                        var posts = [];
                        db_posts.forEach(function (key, val) {
                            if (key == 'created' || key == 'created-plain' || key == 'Ignore') {
                                return;
                            }
                            var d = new Date(val[4].time);
                            d = d.getFullYear() + '-' + String(d.getMonth()).lpad(0, 2) + '-' + String(d.getDay()).lpad(0, 2) +
                                    ' ' + String(d.getHours()).lpad(0, 2) + ':' + String(d.getMinutes()).lpad(0, 2);
                            posts.push(key + ':' + d + ':' + val[2].name);
                        });
                        api.emit('sendMail', 'Aktuella poster:<br />' + posts.join('<br />'), mail.headers.from, 'Admin:list');
                        break;
                    case 'del':
                        db_posts.rm(args[2].trim());
                        api.emit('sendMail', 'Tog bort post med nykel ' + args[2].trim(), mail.headers.from, 'Admin:del');
                        break;
                    default:
                        if (args[1].trim().length < 6) {
                            key = args[1].trim();
                            logger.log(JSON.stringify(subject));
                            logger.log(JSON.stringify(subject.indexOf(':', 6)));
                            subject = subject.substr(subject.indexOf(':', 6) + 1);
                            logger.log(JSON.stringify(subject));
                        } else {
                            key = crypto.createHash('md5').update(JSON.stringify(mail)).digest("hex").substr(0, 5);
                            subject = subject.substr(subject.indexOf(':') + 1);
                        }
                        var date = new Date().valueOf();
                        logger.log('adminAction:' + key);
                        var struct = [
                            {
                                type: "vservers",
                                name: key
                            }, {
                                type: "events",
                                name: mail.headers.date[0]
                            }, {
                                type: "general",
                                name: subject
                            }, {
                                type: "actions",
                                name: html_entities.encode(mail.body).replace(/&NewLine;/g, '<br />')
                            }, {
                                time: date
                            }
                        ];
                        newPost(key, struct);
                        api.emit('sendMail', 'Ny post mottagen.<br />Nykel(' + key + ').<br />Börja ämnet med drift:&lt;nykel&gt;: för att uppdatera denna post.',
                                mail.headers.from, 'Admin');
                        break;
                }
            }
        };

        newPost = function (key, val) {
            db_posts.set(key, val);
            db_mailinglist.forEach(function (mk, mv) {
                api.emit('sendMail', val[3].name, mv.email, 'Driftinfo PA Kompetens: ' + val[2].name);
            });
            api.emit('newNews');
        }

        subscribeAction = function (mail) {
            var from = mail.headers.from;
            var key = crypto.createHash('md5').update(from).digest("hex");
            var struct = db_mailinglist.get(key);
            if (typeof (struct) == 'undefined') {
                struct = {
                    email: from,
                    mail_type: 'all'
                };
                db_mailinglist.set(key, struct);
                api.emit('sendMail', 'Din e-post adress har nu blivit tillagt för drift mailutskick.<br />Önskar du inte få fler mail, skicka ett nytt mail till pakompetens.drift@gmail.com', from, 'Driftinfo PA Kompetens');
            } else {
                db_mailinglist.rm(key);
                api.emit('sendMail', 'Din e-post adress har nu blivit borttagen från drift mailutskick.', from, 'Driftinfo P A Kompetens');
            }
        };

        checkChangesAlert = function (service) {
            if (!lastService[service.name]) {
                lastService[service.name] = {};
                lastService[service.name].status = 'first';
            }
            //logger.log("dotcloud check: "+service.name+" "+service.status);
            if (lastService[service.name].status != service.status) {
                var triggerTime = new Date().getTime();
                var checkObj = {};
                checkObj.zxtm = 'dotcloud';
                checkObj.time = triggerTime;
                if (service.status == 'up') {
                    checkObj.primary_tag = 'pools_poolok';
                    service.message = 'External check: OK';
                } else {
                    checkObj.primary_tag = 'pools_pooldied';
                    if (service.message == "") {
                        service.message = " unknown error";
                    }
                    service.message = 'External check: ' + service.message;
                }
                checkObj.objects = {"Item": [{"type": "pools", "name": service.name}, {"type": "nodes", "name": service.host}]}
                checkObj.description = service.message;
                sortSoap(checkObj);
            }
            lastService[service.name].status = service.status;
        };
    }
};

module.exports.ping = function () {
    return "SUVI:" + new Date(db_pings.get('suvi')).toString() + "ZXTM:" + new Date(db_pings.get('zxtm')).toString();
};
