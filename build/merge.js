const fs = require('fs');
const diff = require('./diff.js');
const remotes = require('./remote.js');
const pismoutil = require('./pismoutil.js');
const branches = require('./branch.js');
const { logInfo, logError } = pismoutil.getLogger(__filename);
const Branch = branches.Branch;
/** @typedef {pismoutil.TreeFile} TreeFile */
/** @typedef {pismoutil.FileInfo} FileInfo */
/** @typedef {pismoutil.Operation} Operation */
/** @typedef {pismoutil.MergeFile} MergeFile */
/**
 * "Updates" otherTree with new information from baseTree by adding/overwriting
 * all files present in baseTree to otherTree.
 *
 * @param {!TreeFile} baseTree
 * @param {!TreeFile} otherTree
 * @return {!Array<!FileInfo>}
 */
exports.oneWayUpdate = function (baseTree, otherTree) {
    /** @type {!Array<!FileInfo>} */
    const files = [];
    /** @type {!Map<string, !FileInfo>} */
    const oldTreeFilesMap = new Map();
    for (const file of otherTree.files) {
        oldTreeFilesMap.set(file.path, file);
    }
    for (const file of baseTree.files) {
        if (oldTreeFilesMap.has(file.path))
            oldTreeFilesMap.delete(file.path);
        files.push(file);
    }
    for (const file of oldTreeFilesMap.values()) {
        files.push(file);
    }
    files.sort(pismoutil.fileInfoComparator);
    return files;
};
/**
 * @param {!TreeFile} baseTree
 * @param {!TreeFile} otherTree
 * @return {!Array<!Operation>}
 */
function mirrorBaseToOther(baseTree, otherTree) {
    /** @type {!Array<!Operation>} */
    const output = [];
    const differator = diff.differator(baseTree, otherTree);
    while (differator.hasNext()) {
        const [{ treeFile, fileInfo }, second] = differator.next();
        if (second) {
            output.push({
                operator: second.fileInfo.hash === fileInfo.hash ? 'touch' : 'cp',
                operands: [{ tree: 'base', relativePath: fileInfo.path },
                    { tree: 'other', relativePath: second.fileInfo.path }]
            });
        }
        else if (treeFile === baseTree) {
            output.push({
                operator: 'cp',
                operands: [{ tree: 'base', relativePath: fileInfo.path },
                    { tree: 'other', relativePath: fileInfo.path }]
            });
        }
        else if (treeFile === otherTree) {
            output.push({
                operator: 'rm',
                operands: [{ tree: 'other', relativePath: fileInfo.path }]
            });
        }
        else {
            throw new Error('this should never happen');
        }
    }
    return output;
}
/**
 * @param {!TreeFile} baseTree
 * @param {!TreeFile} otherTree
 * @return {!Array<!Operation>}
 */
function twoWayMerge(baseTree, otherTree) {
    /** @type {!Array<!Operation>} */
    const output = [];
    const differator = diff.differator(baseTree, otherTree);
    while (differator.hasNext()) {
        const [{ treeFile, fileInfo }, second] = differator.next();
        if (second) {
            // TODO how can this be properly represented in a merge file?
            output.push({
                operator: second.fileInfo.hash === fileInfo.hash ? 'touch' : 'cp',
                operands: [{ tree: 'base', relativePath: fileInfo.path },
                    { tree: 'other', relativePath: second.fileInfo.path }]
            });
        }
        else if (treeFile === baseTree) {
            output.push({
                operator: 'cp',
                operands: [{ tree: 'base', relativePath: fileInfo.path },
                    { tree: 'other', relativePath: fileInfo.path }]
            });
        }
        else if (treeFile === otherTree) {
            output.push({
                operator: 'cp',
                // TODO should this be this way? i should write a test for this or something
                operands: [{ tree: 'other', relativePath: fileInfo.path },
                    { tree: 'base', relativePath: fileInfo.path }]
            });
        }
        else {
            throw new Error('this should never happen');
        }
    }
    return output;
}
/**
 * @param {!TreeFile} baseTree
 * @param {!TreeFile} otherTree
 * @return {!Array<!Operation>}
 */
function oneWayAdd(baseTree, otherTree) {
    /** @type {!Array<!Operation>} */
    const output = [];
    const differator = diff.differator(baseTree, otherTree);
    while (differator.hasNext()) {
        const [{ treeFile, fileInfo }, second] = differator.next();
        if (second) {
            console.log('warning: file found on both sides: "' + fileInfo.path + '", using base');
            output.push({
                operator: second.fileInfo.hash === fileInfo.hash ? 'touch' : 'cp',
                operands: [{ tree: 'base', relativePath: fileInfo.path },
                    { tree: 'other', relativePath: second.fileInfo.path }]
            });
        }
        else if (treeFile === baseTree) {
            output.push({
                operator: 'cp',
                operands: [{ tree: 'base', relativePath: fileInfo.path },
                    { tree: 'other', relativePath: fileInfo.path }]
            });
        }
        else if (treeFile === otherTree) {
            // do nothing, thats the point of this style of merge.
        }
        else {
            throw new Error('this should never happen');
        }
    }
    return output;
}
/**
 * @param {import('./pismo.js').MergeGenArgs} argv
 */
exports.merge = async function (argv) {
    const outputFilepath = argv['output-filepath'];
    const mode = argv['mode'];
    /** @type {?TreeFile} */
    let baseTree = null;
    /** @type {?TreeFile} */
    let otherTree = null;
    const baseBranch = new Branch(argv.base);
    const otherBranch = new Branch(argv.other);
    if (baseBranch.remote()) {
        const remote = await remotes.getOrCreateRemote(baseBranch.remote());
        baseTree = await remote.readTreeByName(baseBranch.name());
    }
    else {
        baseTree = await pismoutil.readTreeByName(baseBranch.name());
    }
    if (otherBranch.remote()) {
        const remote = await remotes.getOrCreateRemote(otherBranch.remote());
        otherTree = await remote.readTreeByName(otherBranch.name());
    }
    else {
        otherTree = await pismoutil.readTreeByName(otherBranch.name());
    }
    // merge format will be a list of operations
    // each operation has:
    //   operator: rm, cp
    //   operands: one or two files, with specificity to base or other tree.
    //             [{tree: 'C:\cygwin64\home\jarhar', file: FileInfo}]
    // TODO use file tree name or path as identifier here??
    // TODO use path as unique identifier everywhere instead of nickname,
    //      reimplement nicknames as an optional feature
    let operations = null;
    switch (argv['mode']) {
        case 'one-way-mirror':
            operations = mirrorBaseToOther(baseTree, otherTree);
            break;
        case 'two-way-sync':
            operations = twoWayMerge(baseTree, otherTree);
            break;
        case 'one-way-add':
            operations = oneWayAdd(baseTree, otherTree);
            break;
        default:
            throw new Error(`Unrecognized merge mode: ${argv['mode']}`);
    }
    /** @type {!MergeFile} */
    const output = {
        baseBranch: baseBranch.rawString(),
        otherBranch: otherBranch.rawString(),
        operations: operations
    };
    const writeFileError = await new Promise(resolve => {
        fs.writeFile(outputFilepath, JSON.stringify(output, null, 2), resolve);
    });
    if (writeFileError) {
        logError(`Failed to write merge file to filepath: ${outputFilepath}`);
        throw writeFileError;
    }
};
