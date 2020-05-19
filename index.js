const http = require('http');
const fs = require('fs');
const {EventEmitter} = require('events');
const {createHmac} = require('crypto');

const cacheFilePath = '/tmp/nodejs-sse.json';
const cwtInTitle = title => title.match(/\bcwt\b/i) !== null;
const userIdFromUrl = url => url.split('/')[2];
const asEvent = payload => 'data: ' + JSON.stringify(payload) + '\n\n';
const bold = txt => '\033[1m' + txt + '\033[0m';
const assert = (expression, fallback) => {
  try { return expression(); }
  catch { return fallback; }
};

const args = '|' + process.argv.slice(2).join('|') + '|';
const port = assert(() => args.match(/\|--?p(?:ort)? ?([0-9]+)\|/)[1], 9999);
const help = assert(() => args.match(/\|--?h(?:elp)?\|/) != null, false);
const verifySignature = args.indexOf('|--no-signature|') === -1;
const streams = assert(() => JSON.parse(fs.readFileSync(cacheFilePath).toString()), []);
const hostname = assert(() => args.match(/\|--host (?:https?:\/\/)(.+?)\/?\|/)[1], 'localhost:9999');

if (help) {
  console.info(`
    ${bold('CACHE')}
    Upon exiting the program the current state
    is serialized to ${bold(cacheFilePath)}
    and is read on next startup.

    ${bold('ENVIRONMENT')}
    ${bold('TWITCH_CLIENT_SECRET')}   Twitch API client secret
    ${bold('TWITCH_CLIENT_ID')}       Twitch API client ID
    
    ${bold('OPTIONS')}
    ${bold('--no-signature')}   Skip signature check
    ${bold('--port 80')}        Run on port 80 (defaults to 9999)
    ${bold('--host abc.com')}   This server's hostname (defaults to localhost)
    ${bold('--help')}           Display this help
  `);

  process.exit(0);
}

if (!process.env.TWITCH_CLIENT_SECRET || !process.env.TWITCH_CLIENT_ID) {
  console.error('You did not provide required environment variables.');
  process.exit(1);
}

if (!process.env.TWITCH_CLIENT_SECRET && verifySignature) {
  console.error('Please provide a secret via environment variable.');
  process.exit(1);
}

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(Infinity); // uh oh

const server = http.createServer((req, res) => {
  if (req.url === '/favicon.ico') return endWithCode(res, 404);

  bodify(req, (body, raw) => {
    try {
      console.info(`
${req.method} ${req.url} at ${Date.now()}
Headers: ${JSON.stringify(req.headers)}
Payload: ${body && JSON.stringify(body)}`);
      req.on('error', console.error);
      cors(req, res);
      if (req.url.startsWith('/consume')) consume(req, res, body, raw);
      else if (req.url === '/produce') produce(req, res);
      else if (req.url === '/current') current(req, res);
      else if (req.url.startsWith('/subscribe')) subUnsub(req, res, 'subscribe');
      else if (req.url.startsWith('/unsubscribe')) subUnsub(req, res, 'unsubscribe');
      else endWithCode(res, 404)
    } catch (e) {
      console.error(e);
      endWithCode(res, 500);
    }
  });
}).listen(port);

function consume(req, res, body, raw) {
  const hubCallback = new URL(req.url, `http://${hostname}`).searchParams.get('hub.challenge');
  if (hubCallback != null) {
    console.info('Verifying callback.', hubCallback);
    return endWithCode(res, 202, hubCallback);
  }

  if (!validateContentLength(req, res, raw)) return;
  if (!validateSignature()) return;

  if (body.data.length !== 0) {
    let newStreams = body.data
      .filter(e => streams.map(s => s.event_id).indexOf(e.id) === -1)
      .filter(e => cwtInTitle(e.title));
    if (newStreams.length === 0) return endWithCode(res, 200);

    streams.push(...body.data.map(e => ({
      event_id: e.id,
      title: e.title,
      user_id: e.user_id,
      user_name: e.user_name
    })))
  } else { // stream's gone off
    const userId = userIdFromUrl(req.url);
    if (userId == null) return endWithCode(res, 404);
    let idxOfToBeRemovedStream = streams.findIndex(s => s.user_id === userId);
    while (idxOfToBeRemovedStream !== -1) {
      streams.splice(idxOfToBeRemovedStream, 1);
      idxOfToBeRemovedStream = streams.findIndex(s => s.user_id === userId);
    }
  }

  eventEmitter.emit('stream');
  endWithCode(res, 200)
}

function produce(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.write(asEvent(streams));

  const eventListener = () => res.write(asEvent(streams));
  eventEmitter.addListener('stream', eventListener);
  res.on('close', () => eventEmitter.removeListener('stream', eventListener))
}

function subUnsub(req, res, subUnsubAction) {
  const userId = userIdFromUrl(req.url);
  if (userId == null) return endWithCode(res, 404);
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'client-id': process.env.TWITCH_CLIENT_ID,
      'Authorization': 'Bearer yourToken' // todo this whole script should do authentication on its own
    }
  };

  const twitchReq = require('https').request(
      'https://api.twitch.tv/helix/webhooks/hub',
      options, (twitchRes) => {
        bodify(twitchRes, body => {
          console.info(`${subUnsubAction}d to ${userId} with HTTP status ${twitchRes.statusCode}`);
          endWithCode(res, 200);
        });
      });

  twitchReq.on('error', console.error);

  twitchReq.write(JSON.stringify({
    "hub.callback": `http://${hostname}/consume/${userId}`,
    "hub.mode": subUnsubAction,
    "hub.topic": `https://api.twitch.tv/helix/streams?user_id=${userId}`,
    "hub.secret": process.env.TWITCH_CLIENT_SECRET,
    "hub.lease_seconds": 864000,
  }));
  twitchReq.end()
}

function bodify(req, cb) {
  let body = '';
  req
      .on('data', chunk => body += chunk)
      .on('end', () => {
        if (!body) return cb(null);
        try {
          cb(JSON.parse(body), body)
        } catch (e) {
          console.warn('body could not be parsed', e);
          cb(null);
        }
      });
}

function current(req, res) {
  res.setHeader('Content-Type', 'application/json');
  endWithCode(res, 200, JSON.stringify(streams))
}

function validateSignature(req, res, raw) {
  if (!verifySignature) return true;

  const signature = req.headers['X-Hub-Signature'];
  const expectedSignature = createHmac('sha256', process.env.TWITCH_CLIENT_SECRET)
      .update(raw)
      .digest('hex');

  if (signature !== `sha256=${expectedSignature}`) {
    console.error('Invalid signature.');
    endWithCode(res, 400);
    return false
  }
}

function validateContentLength(req, res, raw) {
  const contentLengthHeader = req.headers['content-length'];
  if (contentLengthHeader == null) {
    endWithCode(res, 411);
    return false
  }

  const contentLengthFactual = Buffer.byteLength(raw, 'utf8');
  if (parseInt(contentLengthHeader) !== contentLengthFactual) {
    console.error('Content-Length mismatch.');
    endWithCode(res, 400);
    return false
  }

  return true
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS,POST,PUT");
  res.setHeader("Access-Control-Allow-Headers", "*")
}

function endWithCode(res, code, payload) {
  res.statusCode = code;
  res.end(payload)
}

function shutdownHook() {
  server.close(console.error);
  fs.writeFileSync(cacheFilePath, JSON.stringify(streams));
  console.info('Exiting');
  process.exit(0)
}

['SIGINT', 'SIGTERM', 'SIGQUIT'].forEach(sig => process.on(sig, shutdownHook));

