
import { trimBOM, decodeString } from '../text/mapshaper-encodings';
import { stop, error, message } from '../utils/mapshaper-logging';
import { Buffer } from '../utils/mapshaper-node-buffer';
import utils from '../utils/mapshaper-utils';
import { runningInBrowser } from '../mapshaper-env';
import { getStashedVar } from '../mapshaper-stash';
import { parseLocalPath } from '../utils/mapshaper-filename-utils';
import require from '../mapshaper-require';

var cli = {};

export default cli;

cli.isFile = function(path, cache) {
  if (cache && (path in cache)) return true;
  if (runningInBrowser()) return false;
  var ss = cli.statSync(path);
  return ss && ss.isFile() || false;
};

// cli.fileSize = function(path) {
//   var ss = cli.statSync(path);
//   return ss && ss.size || 0;
// };

cli.isDirectory = function(path) {
  if (runningInBrowser()) return false;
  var ss = cli.statSync(path);
  return ss && ss.isDirectory() || false;
};

// @encoding (optional) e.g. 'utf8'
cli.readFile = function(fname, encoding, cache) {
  var content;
  if (cache && (fname in cache)) {
    content = cache[fname];
    delete cache[fname];
  } else if (fname == '/dev/stdin') {
    content = require('rw').readFileSync(fname);
  } else {
    // kludge to prevent overwriting of input files
    (getStashedVar('input_files') || []).push(fname);
    content = require('fs').readFileSync(fname);
  }
  if (encoding && Buffer.isBuffer(content)) {
    content = trimBOM(decodeString(content, encoding));
  }
  return content;
};

cli.createDirIfNeeded = function(fname) {
  var odir = parseLocalPath(fname).directory;
  if (!odir || cli.isDirectory(odir) || fname == '/dev/stdout') return;
  try {
    require('fs').mkdirSync(odir, {recursive: true});
    message('Created output directory:', odir);
  } catch(e) {
    stop('Unable to create output directory:', odir);
  }
};

const isStream = (obj) => obj !== null && typeof obj === 'object' && typeof obj.pipe === 'function';

// content: Buffer or string
cli.writeFileSync = function(fname, content) {
  cli.createDirIfNeeded(fname);
  if (utils.isString(content)) {
    require('fs').writeFileSync(fname, content);
  } else if (isStream(content)) {
    cli.writeStream(fname, content);
  } else {
    // as of Node.js v20, on a typical machine, max buffer size is 4gb but the max
    // write buffer size is 2gb. An error is thrown when writing >2gb and <4gb.
    // To support writing files up to 4gb, files are written in chunks.
    cli.writeFileInChunks(fname, content, 1e7);
  }
};

cli.writeStream = function(fname, stream) {
  var fs = require('fs');
  var deasync = require('deasync');

  const writeSyncFromStream = deasync(function(cb) {
    var dest = fs.createWriteStream(fname);
    stream.pipe(dest);
    stream.on('end', () => cb(null, null));
  });

  writeSyncFromStream();
}

cli.writeFileInChunks = function(fname, buffer, chunkSize) {
  var fs = require('fs');
  var fd = fs.openSync(fname, 'w');
  var offset = 0;
  var bufLen = buffer.length;
  var bytesWritten, bytesToWrite;
  do {
    bytesToWrite = Math.min(chunkSize, bufLen - offset);
    bytesWritten = fs.writeSync(fd, buffer, offset, bytesToWrite);
    offset += bytesWritten;
  } while (bytesWritten > 0 && offset < bufLen);
  fs.closeSync(fd);
};

// Returns Node Buffer
cli.convertArrayBuffer = function(buf) {
  var src = new Uint8Array(buf),
      dest = utils.createBuffer(src.length);
  for (var i = 0, n=src.length; i < n; i++) {
    dest[i] = src[i];
  }
  return dest;
};

// Receives a directory path, in which the final subdirectory may include the
//   "*" wildcard, e.g. '.' 'data' '*' 'data/*' '2023-*'
// Returns an array of expanded directory names
// TODO: add support for wildcards in other subdirectories
cli.expandDirectoryName = function(name) {
  var info = parseLocalPath(name);
  // final directory name is parsed as info.filename
  if (!info.filename.includes('*')) {
    return [name];
  }
  var rxp = utils.wildcardToRegExp(info.filename);
  var dirs = [];
  require('fs').readdirSync(info.directory || '.').forEach(function(item) {
    var path = info.directory ? require('path').join(info.directory, item) : item;
    if (rxp.test(item) && cli.isDirectory(path)) {
      dirs.push(path);
    }
  });
  return dirs;
};

// Expand any "*" wild cards in file name
// (For the Windows command line; unix shells do this automatically)
cli.expandFileName = function(name) {
  var info = parseLocalPath(name),
      rxp = utils.wildcardToRegExp(info.filename),
      dirs = cli.expandDirectoryName(info.directory || '.'),
      files = [];

  try {
    dirs.forEach(function(dir) {
      require('fs').readdirSync(dir).forEach(function(item) {
        var path = require('path').join(dir, item);
        if (rxp.test(item) && cli.isFile(path)) {
          files.push(path);
        }
      });
    });
  } catch(e) {}

  if (files.length === 0) {
    stop('No files matched (' + name + ')');
  }
  return files;
};

// Expand any wildcards.
cli.expandInputFiles = function(files) {
  return files.reduce(function(memo, name) {
    if (name.indexOf('*') > -1) {
      memo = memo.concat(cli.expandFileName(name));
    } else {
      memo.push(name);
    }
    return memo;
  }, []);
};

cli.validateOutputDir = function(name) {
  if (!cli.isDirectory(name) && !runningInBrowser()) {
    error("Output directory not found:", name);
  }
};

// TODO: rename and improve
// Want to test if a path is something readable (e.g. file or stdin)
cli.checkFileExists = function(path, cache) {
  if (!cli.isFile(path, cache) && path != '/dev/stdin') {
    stop("File not found (" + path + ")");
  }
};

cli.statSync = function(fpath) {
  var obj = null;
  try {
    obj = require('fs').statSync(fpath);
  } catch(e) {}
  return obj;
};
