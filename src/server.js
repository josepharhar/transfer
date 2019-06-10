const path = require('path');
const fs = require('fs');
const stream = require('stream');
const crypto = require('crypto');

const express = require('express');
const bodyParser = require('body-parser');
const progress = require('progress-stream');
// @ts-ignore
const nanostat = require('nanostat');
// @ts-ignore
const nanoutimes = require('nanoutimes');

const api = require('./api.js');
const pismoutil = require('./pismoutil.js');
const {logInfo, logError} = pismoutil.getLogger(__filename);

/**
 * @param {!Object} params
 * @return {!Promise<!api.GetTreesResponse>}
 */
async function handleGetTrees(params) {
  const treeNamesToPaths = await pismoutil.getTreeNamesToPaths();

  /** @type {!api.GetTreesResponse} */
  const response = {
    trees: []
  };

  for (const name in treeNamesToPaths) {
    /** @type {!pismoutil.TreeFile} */
    const treefile = await pismoutil.readFileToJson(
      treeNamesToPaths[name]);
    if (!treefile) {
      logError(`Failed to read tree json file for name: ${name}`);
      continue;
    }
    response.trees.push({
      treename: name,
      treefile: treefile
    });
  }

  return response;
}

/**
 * @param {!Object} paramsObj
 * @return {!Promise<!api.GetFileTimeResponse>}
 */
async function handleGetFileTime(paramsObj) {
  const request = api.GetFileTime.parseRequest(paramsObj);

  // TODO use a caching layer like remotes for this
  const treeFile = await pismoutil.readTreeByName(request.treename);
  const absolutePath = path.join(treeFile.path, request.relativePath);

  /** @type {!pismoutil.Stats} */
  const stats = pismoutil.stat(absolutePath);
  /** @type {!GetFileTimeResponse} */
  return {
    mtimeS: Number(stats.mtimeMs / 1000n),
    mtimeNs: Number(stats.mtimeNs)
  };
}

/**
 * @param {!Object} paramsObj
 * @return {!Promise<!api.SetFileTimeResponse>}
 */
async function handleSetFileTime(paramsObj) {
  const request = api.SetFileTime.parseRequest(paramsObj);

  // TODO use a caching layer like remotes for this
  const treeFile = await pismoutil.readTreeByName(request.treename);
  const absolutePath = path.join(treeFile.path, request.relativePath);

  nanoutimes.utimesSync(absolutePath, null, null, request.mtimeS, request.mtimeNs);
}

/**
 * @param {!Object} paramsObj 
 * @return {!Promise<stream.Readable>}
 */
async function handleGetFile(paramsObj) {
  const request = api.GetFile.parseRequest(paramsObj);

  const treeFile = await pismoutil.readTreeByName(request.treename);
  const absolutePath = path.join(treeFile.path, request.relativePath);

  return fs.createReadStream(absolutePath, {
    encoding: 'binary'
  });
}

/** @type {!Map<string, !{treename: string, relativePath: string, filesize: number}>} */
const _putIdToTreeAndPath = new Map();
/**
 * @param {!Object} paramsObj
 * @return {!Promise<!api.PreparePutFileResponse>}
 */
async function handlePreparePutFile(paramsObj) {
  const {treename, relativePath, filesize} = api.PreparePutFile.parseRequest(paramsObj);

  function generatePutId() {
    return crypto.randomBytes(20).toString('hex');
  }
  let newPutId = generatePutId();
  while (_putIdToTreeAndPath.has(newPutId))
    newPutId = generatePutId();

  _putIdToTreeAndPath.set(newPutId, {
    treename: treename,
    relativePath: relativePath,
    filesize: filesize
  });

  return {
    putId: newPutId
  };
}

/**
 * @param {!Object} paramsObj 
 */
async function handleDeleteFile(paramsObj) {
  const request = api.DeleteFile.parseRequest(paramsObj);

  const treeFile = await pismoutil.readTreeByName(request.treename);
  const absolutePath = path.join(treeFile.path, request.relativePath);
  await new Promise((resolve, reject) => {
    fs.unlink(absolutePath, error => {
      if (error)
        reject(error)
      else
        resolve();
    });
  })
}

/**
 * @param {import('./pismo.js').ServerArgs} argv
 */
exports.server = async function(argv) {
  const port = argv.port;
  logInfo(`Running server on port ${port}`);

  const app = express();
  //app.use(express.json());
  //app.use(express.urlencoded());
  app.use(bodyParser.urlencoded({extended: false}));
  app.use(bodyParser.json());

  app.use((req, res, next) => {
    console.log(`${req.method} ${req.url} ${JSON.stringify(req.headers, null, 2)}`);
    next();
  });

  app.get('/', (req, res) => {
    res.send('Hello world');
  });

  // TODO why doesnt this work with get?
  app.post('/api', async (req, res) => {
    if (!req.body) {
      res.writeHead(500, {'content-type': 'text/plain'});
      res.end('!req.body');
      return;
    }

    // req.body will be {} if the request was malformed:
    //   no body, non-json body, or wrong content-type
    //   TODO or if its a GET too???
    if (Object.entries(req.body).length === 0) {
      res.writeHead(400, {'content-type': 'text/plain'});
      res.end('req.body: ' + JSON.stringify(req.body));
      return;
    }

    /** @type {?stream.Readable} */
    let readableStreamResponse = null;
    const method = req.body.method;
    const params = req.body.params;
    async function dispatchToHandler() {
      console.log('dispatchToHandler method: ' + method);
      switch (method) {
        case api.GetTrees.id():
          return await handleGetTrees(params);
        case api.GetFileTime.id():
          return await handleGetFileTime(params);
        case api.SetFileTime.id():
          return await handleSetFileTime(params);
        case api.GetFile.id():
          readableStreamResponse = await handleGetFile(params);
          return null;
        case api.PreparePutFile.id():
          return await handlePreparePutFile(params);
        case api.DeleteFile.id():
          return await handleDeleteFile(params);
        default:
          throw new Error('unrecognized request method: ' + method);
      }
    }

    let retObj = null;
    try {
      retObj = await dispatchToHandler();
    } catch (error) {
      console.log('got error from dispatchToHandler()');
      //res.writeHead(500, {'content-type': 'text/plain'});
      res.status(500);
      let output = '';
      if (error.wrappedMessage)
        output += error.wrappedMessage + '\n';
      output += error.stack;
      res.send(output); // .send() internally calls res.end()
      //res.send(error.stack); // .send() internally calls res.end()
      return;
    }

    if (readableStreamResponse) {
      res.writeHead(200, {'content-type': 'application/octet-stream'});
      await new Promise((resolve, reject) => {
        readableStreamResponse.on('finish', resolve);
        readableStreamResponse.on('error', reject);
        readableStreamResponse.pipe(res);
      });
      return;
    }

    if (retObj) {
      res.writeHead(200, {'content-type': 'application/json'});
      res.write(JSON.stringify(retObj, null, 2));
    } else {
      res.writeHead(200);
    }
    res.end();
  });

  // TODO wrap this function in a trycatch? to respond with errors?
  app.put('/upload', async (req, res, /* TODO ? next*/) => {
    const putId = req.headers[api.PUT_ID_HEADER_NAME];
    if (typeof(putId) !== 'string' || !_putIdToTreeAndPath.has(putId)) {
      res.writeHead(400, {'content-type': 'text/plain'});
      res.end(typeof(putId) === 'string'
        ? 'provided putId not in _putIdToTreeAndPath'
        : `'${api.PUT_ID_HEADER_NAME}' header missing or invalid. headers: ${JSON.stringify(req.headers, null, 2)}`);
      return;
    }
    //res.end(JSON.stringify({message: 'hello from /upload'}));
    //TODO uncoment this req.on('end', () => { 
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({message: 'hello from /upload'}));
    //});
    req.on('error', error => {
      const errorString = `req.on('error'): ${error}`;
      logError(errorString);
      res.writeHead(500, {'content-type': 'text/plain'});
      res.end(errorString);
    });

    // TODO delet this
    /*const data = await pismoutil.streamToString(req);
    console.log(';asldjhfljkhASDGFJASLDFHASDJFHASDF req body: ' + data);*/

    const {treename, relativePath, filesize} = _putIdToTreeAndPath.get(putId);
    _putIdToTreeAndPath.delete(putId);

    const treefile = await pismoutil.readTreeByName(treename);
    const absolutePath = path.join(treefile.path, relativePath);
    logError(`absolutePath: ${absolutePath}`);
    let fileWriteStream = fs.createWriteStream(absolutePath, {
      // TODO uncomment this? encoding: 'binary'
    });
//    fileWriteStream = fileWriteStream
//      .on('error', error => {
//        console.log('GOT FILE WRITE STREM ERROR: ' + error);
//      })
//      .on('finish', () => {
//        console.log("GOT FILE WRITE FINISH");
//      })
//      .on('close', () => {
//        console.log("GOT FILE WRITE DLOSE");
//      });
//    logError('stream properties:'
//      + '\n  req.readable: ' + req.readable
//      + '\n  req.readableLength: ' + req.readableLength
//      + '\n  fileWriteStream.writable: ' + fileWriteStream.writable
//      + '\n  fileWriteStream.writableLength: ' + fileWriteStream.writableLength);
    // TODO uncomment this req.setEncoding('binary');

    const progressStream = progress({
      length: filesize,
      time: 1000 /* ms interval to print update */
    }, progress => {
      console.log('progress: ' + JSON.stringify(progress));
    });

    const passThroughStream = new stream.PassThrough();
    passThroughStream.on('data', chunk => {
      logError(`/upload GOT CHUNK!!!!!!: ${chunk}`);
    });

    /*req.on('data', data => {
      fileWriteStream.write(data);
    });
    req.on('close', () => {
      fileWriteStream.close();
    })
    req.on('error', error => {
      logError(`req.on('error'): ${error}`);
    });*/
    //req.pipe(fileWriteStream);

    class fuck extends stream.Readable {
      constructor() {
        super();
      }

      _read() {
        //this.push('write this to a file');
      }
    };

    let asdf = new fuck();
    asdf.on('error', error => console.log('\n\n\n\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:\n' + error));
    asdf.push('write this to a god damn file');
    asdf.pipe(fileWriteStream);

    //req.pipe(progressStream).pipe(passThroughStream);
    //req.pipe(progressStream).pipe(passThroughStream).pipe(fileWriteStream);
    //req.pipe(passThroughStream).pipe(progressStream).pipe(fileWriteStream);
    //req.pipe(progressStream).pipe(fileWriteStream);
    //req.pipe(fileWriteStream);
  });

  app.listen(port);

//  app.post('/fileupload', async (req, res) => {
//    console.log(`${req.method} ${req.url} ${JSON.stringify(req.headers, null, 2)}`);
//    const length = Number(req.headers['x-pismo-length']);
//    if (length === NaN) {
//      // TODO
//      console.log('invalid x-pismo-length header: ' + req.headers['x-pismo-length']);
//    }
//    const fileWriteStream = fs.createWriteStream('output.o');
//
//    const progressStream = progress({
//      length: length,
//      time: 1000 /* ms */
//    }, progress => {
//      console.log('progress: ' + JSON.stringify(progress));
//    });
//
//    // TODO should i be doing this?
//    res.end('hello from server');
//
//    req.pipe(progressStream).pipe(fileWriteStream);
//    //req.pipe(fileWriteStream);
//    //await streamPrint(req);
//  });
}

//async function streamPrint(stream) {
//  return new Promise((resolve, reject) => {
//    stream.on('data', chunk => {
//      console.log('data: ' + chunk);
//    });
//    stream.on('error', reject);
//    stream.on('end', resolve);
//  });
//}
//
//async function streamToString(stream) {
//  return new Promise((resolve, reject) => {
//    let chunks = '';
//    stream.on('data', chunk => {
//      chunks += chunk;
//    });
//    stream.on('error', reject);
//    stream.on('end', () => resolve(chunks));
//  });
//}
//