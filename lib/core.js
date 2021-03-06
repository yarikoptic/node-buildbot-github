var util = require('util');
var url = require('url');
var EventEmitter = require('events').EventEmitter;

var GitHubApi = require('./extern/node-github').GitHubApi;
var async = require('async');
var sprintf = require('sprintf').sprintf;
var log = require('logmagic').local('buildbot-github.core');
var LRU = require('lru-cache');

var BuildBot = require('./buildbot').BuildBot;
var utils = require('./utils');
var pollers = require('./pollers');
var server = require('./server');
var constants = require('./constants');

function BuildbotGithub(options) {
  this._options = options;

  this._buildbotPoller = null;
  this._server = null;

  this._pullCache = new LRU(this._options['general']['build_cache_size'] || constants.DEFAULT_BUILD_CACHE_SIZE);
}

util.inherits(BuildbotGithub, EventEmitter);

BuildbotGithub.prototype._initialize = function() {
  var options;

  this._github = new GitHubApi(false);
  this._github.authenticateToken(this._options['github']['username'],
                                 this._options['github']['token']);

  // Set up server which listens for webhook events
  options = utils.merge({'username': this._options['github']['username'],
                         'trigger_string': this._options['general']['trigger_string']},
                         this._options['webserver']);
  this._server = new server.WebServer(options);

  // Set up poller
  this._buildbotPoller = new pollers.BuildbotPoller(this._options['buildbot'],
                                                    this._options['buildbot']['poll_interval']);

  // Set up Buildbot instance
  this._buildbot = new BuildBot(this._options['buildbot']);

  // Register change handlers
  this._buildbotPoller.on('new_build', this._handleNewBuild.bind(this));
  this._server.on('trigger_comment', this._handleTriggerComment.bind(this));
};

BuildbotGithub.prototype.start = function() {
  this._initialize();

  this._server.start();
  this._buildbotPoller.start();
};

BuildbotGithub.prototype.stop = function() {
  this._server.stop();
  this._buildbotPoller.stop();
};

BuildbotGithub.prototype._handleNewBuild = function(build) {
  var properties, pullId, revision, key, requestCache;
  properties = build.properties || [];
  pullId = utils.getPropertyValue(properties, 'pull-request-id');
  revision = utils.getPropertyValue(properties, 'revision');
  key = sprintf('%s-%s', pullId, revision);

  if (!pullId || !revision) {
    // Not triggered by us.
    return;
  }

  // Check if there are any pending builds with this key
  requestCache = this._pullCache.get(key);

  if (!requestCache || !requestCache['build_pending']) {
    log.infof('No pending builds for pull request #${id}', {'id': pullId,
                                                            'key': key});
    return;
  }

  requestCache['build_pending'] = false;
  this._postPullRequestComment(build, pullId, key);
};

BuildbotGithub.prototype._handleTriggerComment = function(payload) {
  var self = this,
      pullId = payload.issue.number;

  async.waterfall([
    function getDiscussion(callback) {
      // Pretty lame way to retrieve pull request info but atm I don't want t
      // deal with v3 api.
      self._github.getPullApi().getDiscussion(self._options['github']['user'],
                                              self._options['github']['project'],
                                              pullId, callback);
    },

    function populateCache(data, callback) {
      // TODO: Redis, kktnxbye
      var revision = data.head.sha, requestCache,
          key = sprintf('%s-%s', pullId, revision);

      if (!self._pullCache.get(key)) {
        self._pullCache.set({
          'id': pullId,
          'build_pending': true
        });
      }

      requestCache = self._pullCache.get(key);
      requestCache['updated'] = parseInt(new Date().getTime() / 1000, 10);
      callback(null, data);
    },

    function sendChanges(data, callback) {
      var id = data.number,
          user = data.user,
          revision = data.head.sha,
          branch = data.head.ref;

      log.infof('Sending changes to buildbot', {'id': id, 'revision': revision,
                                               'branch': branch});
      self._buildbot.sendChanges(id, revision, user,
                                 self._options['github']['project'],
                                 self._options['github']['repository'],
                                 self._options['buildbot']['category'],
                                 branch, callback);
    }
  ],

  function(err) {
    if (err) {
      log.errorf('Sending changes failed: ${err}', {'err': err});
      return;
    }

    log.infof('Successfully sent changes to buildbot');
  });
};

BuildbotGithub.prototype._postPullRequestComment = function(build, pullId,
                                                            key) {
  var self = this,
      requestCache, commentString, commentBody;
  requestCache = this._pullCache.get(key);

  function getTemplateObj() {
    var text, buildNumber, buildStatus, rand, image;

    buildNumber = build['number'];
    text = build['text'].join('');

    if (text.toLowerCase().indexOf('failed') !== -1) {
      buildStatus = 'failure';
      rand = utils.getRandomInt(0, self._options['templates']['images_failure'].length - 1);
      image = self._options['templates']['images_failure'][rand];
    }
    else {
      buildStatus = 'success';
      rand = utils.getRandomInt(0, self._options['templates']['images_success'].length - 1);
      image = self._options['templates']['images_success'][rand];
    }

    var urlObj = {
      protocol: (self._options['buildbot']['secure']) ? 'https:' : 'http',
      host: self._options['buildbot']['host'],
      port: self._options['buildbot']['port'],
      query: '',
      pathname: sprintf('/builders/%s/builds/%s',
                        self._options['buildbot']['builder_name'], buildNumber)
    };

    var templateObj = {
      'branch': build['sourceStamp']['branch'],
      'blame': build['blame'][0],
      'nickname': utils.getPropertyValue(build['properties'],
                                         'github-nickname'),
      'number': buildNumber,
      'builder_name': build['builderName'],
      'status': buildStatus,
      'build_url': url.format(urlObj),
      'image': image
    };

    return templateObj;
  }

  log.infof('Posting comment with build results to pull request #${id}',
           {'id': pullId});

  var templateObj = getTemplateObj();
  if (templateObj['status'] === 'success') {
    commentString = this._options['templates']['comment_success'];
  }
  else {
    commentString = this._options['templates']['comment_failure'];
  }

  commentBody = utils.applyFormatting(commentString, templateObj);
  this._github.getIssueApi().addComment(self._options['github']['user'],
                                        self._options['github']['project'],
                                        pullId, commentBody,
                                        function(err, body) {
    if (err) {
      log.errorf('Posting comment to pull request #${id} failed: ${err}',
                {'id': pullId, 'err': err.toString()});
      return;
    }

    log.infof('Successfully posted comment to pull request #${id}: ${body}',
             {'id': pullId, 'body': commentBody});
  });
};

exports.BuildbotGithub = BuildbotGithub;
