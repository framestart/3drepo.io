/*global require*/

var http = require("http");
var express = require('express');
var logger = require('./js/core/logger.js');
var db_interface = require('./js/core/db_interface.js');
var x3dom_encoder = require('./js/core/x3dom_encoder.js');
var config = require('app-config').config;

var app = express();

var authArray = require('./auth.json');
var auth = express.basicAuth(function(user, password) {
    return authArray.some(function(entry) {
        return entry.user === user && entry.password === password;
    })
})

app.set('view engine', 'jade');
app.set('views', './public');

app.use(auth);

app.use(express.compress());
app.use(app.router);
app.use(express.static('./public'));
app.locals.pretty = true;

app.get('/', function(req, res, next) {
    res.end();
});

app.get('/xml3drepo/:db_name', function(req, res, next) {
    console.log('Opening scene ' + req.param('db_name'));
    x3dom_encoder.render(db_interface, req.param('db_name'), 'xml', 'src', null, null, null, res);
});

app.get('/xml3drepo/src_bin/:db_name/:uuid/level:lvl.pbf', function(req, res, next) {
    x3dom_encoder.render(db_interface, req.param('db_name'), 'pbf', null, req.param('lvl'), req.param('uuid'), null, res);
});

app.get('/xml3drepo/:db_name/textures/:uuid.:format', function(req, res, next) {
    x3dom_encoder.get_texture(db_interface, req.param('db_name'), req.param('uuid'), res);
});

app.get('/xml3drepo/:db_name/:type/:uuid.bin', function(req, res, next) {
    x3dom_encoder.get_mesh_bin(db_interface, req.param('db_name'), req.param('uuid'), req.param('type'), res);
});

app.get('/xml3drepo/src_bin/:db_name/:uuid.:format/:texture?', function(req, res, next) {
    console.log('Requesting mesh ' + req.param('uuid') + ' ' + req.param('texture'));
    x3dom_encoder.render(db_interface, req.param('db_name'), req.param('format'), null, null, req.param('uuid'), req.param('texture'), res);
});

http.createServer(app).listen(config.server.http_port, function() {
    logger.log('info', 'Application Started');
});
