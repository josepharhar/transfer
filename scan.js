const fs = require('fs');
const path = require('path');
const util = require('util');
const crypto = require('crypto');

const readFile = util.promisify(fs.readFile);
const readdir = util.promisify(fs.readdir);
const lstat = util.promisify(fs.lstat);
const writeFile = util.promisify(fs.writeFile);

async function main() {
  function printUsageAndExit() {
    console.log('usage: node scan.js <output.json> [/path/to/scandir]');
    console.log('   If output.json already exists, it will be updated');
    console.log('   to reflect the changes in the directory it originally');
    console.log('   scanned, and file hashes will be reused.');
    process.exit(1);
  }

  if (process.argv.length < 3) {
    printUsageAndExit();
  }

  const outpath = path.resolve(process.argv[2]);

  let {cache, basepath} = await readcache(outpath);
  if (!basepath) {
    if (process.argv.length < 4) {
      console.log('Path to scan could not be determined from cache file');
      console.log('  and was not passed as a command line parameter.');
      printUsageAndExit();
    }
    basepath = path.resolve(process.argv[3]);
  } else if (process.argv.length > 3) {
    console.log('Using scan path ' + basepath + ' from cache file instead of supplied ' + process.argv[3]);
  }

  const file_info_array = [];
  await scandir(basepath, '/', file_info_array, cache);

  file_info_array.sort((a, b) => {
    if (a.path < b.path)
      return -1;
    if (a.path > b.path)
      return 1;
    return 0;
  });

  const output = {
    'basepath': basepath,
    'file_info_array': file_info_array
  };
  await writeFile(outpath, JSON.stringify(output, null, 2));
}

/**
 * Cache maps from relative filepath to full FileInfo
 * @return {?object<string, FileInfo>}
 */
async function readcache(cache_filepath) {
  let filedata = null;
  try {
    filedata = await readFile(cache_filepath);
  } catch (e) {
    // failed to read cache, probably there is none.
    console.log('no cache file found');
    return {cache: null, basepath: null};
  }

  const cache_tree = JSON.parse(filedata);
  console.log('found cache file with basepath: ' + cache_tree.basepath);
  const cache = {};
  cache_tree.file_info_array.forEach(file_info => {
    console.log('putting path in cache: ' + file_info.path + ' -> ' + file_info.hash);
    cache[file_info.path] = file_info;
  });
  return {cache: cache, basepath: cache_tree.basepath};
}

/**
 * @param {!string} basepath Platform specific absolute path
 * @param {!string} relative_dirpath Path relative to basepath
 * @param {!Array<FileInfo>} file_info_array
 * @param {?object<string, FileInfo>} cache
 */
async function scandir(basepath, relative_dirpath, file_info_array, cache) {
  const absolute_dirpath = path.join(basepath, relative_dirpath);
  const dir_filenames = await readdir(absolute_dirpath);
  dir_filenames.sort();

  for (let i = 0; i < dir_filenames.length; i++) {
    const filename = dir_filenames[i];
    if (filename.startsWith('.'))
      continue; // ignore dotfiles

    const relative_filepath = path.join(relative_dirpath, filename);
    const absolute_filepath = path.join(basepath, relative_filepath);
    const stat = await lstat(absolute_filepath);

    if (stat.isDirectory()) {
      await scandir(basepath, relative_filepath, file_info_array, cache);

    } else if (stat.isFile()) {
      const file_info = await scanfile(basepath, relative_filepath, cache);
      //file_info.name = filename;
      file_info_array.push(file_info);
    }
  }
}

/**
 * @param {!string} basepath
 * @param {!string} relative_filepath
 * @param {?object<string, FileInfo>} cache
 * @return {!FileInfo}
 */
async function scanfile(basepath, relative_filepath, cache) {
  const file_info = {};

  const absolute_filepath = path.join(basepath, relative_filepath);
  file_info.path = pathToUnix(relative_filepath);

  const stat = await lstat(absolute_filepath);
  file_info.mtime = stat.mtime;
  file_info.size = stat.size;

  // compute hash, using cache if available
  if (cache) {
    const cache_result = cache[file_info.path];
    if (cache_result) {
      const cache_result_copy = JSON.parse(JSON.stringify(cache_result));
      delete cache_result_copy.hash;
      const file_info_copy = JSON.parse(JSON.stringify(file_info));
      delete file_info_copy.hash;

      if (JSON.stringify(file_info_copy) == JSON.stringify(cache_result_copy)) {
        // cache hit!
        file_info.hash = cache_result.hash;
        console.log('used cache for file: ' + file_info.path);
      }
    }
  }
  if (!file_info.hash) {
    console.log('calculating new hash for file: ' + file_info.path);
    try {
      file_info.hash = await fileHash(absolute_filepath);
    } catch (e) {
      console.log('failed to get hash for file: ' + absolute_filepath);
    }
  }

  return file_info;
}

/**
 * @param {!string} path
 */
function pathToUnix(path) {
  return path.replace(/\\/g, '/');
}

function fileHash(absolute_filepath) {
  return new Promise((resolve, reject) => {
    const output = crypto.createHash('md5');
    const input = fs.createReadStream(absolute_filepath);
    input.on('error', err => {
      reject(err);
    });
    output.once('readable', () => {
      resolve(output.read().toString('hex'));
    });
    input.pipe(output);
  });
}

main().catch(error => {
  console.log('caught error:');
  console.log(error);
});
