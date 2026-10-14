const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const assert = require('node:assert/strict');
const root = process.cwd();
const tar = require(path.join(root, 'node_modules/tar'));
(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ogad-native-archive-'));
  try {
    const source = path.join(tmp, 'source');
    await fs.mkdir(path.join(source, 'binding'), {recursive:true});
    const payload = Buffer.from('synthetic native download boundary\n');
    await fs.writeFile(path.join(source, 'binding', 'fixture.node'), payload);
    await tar.create({gzip:true,cwd:source,file:path.join(tmp,'fixture.tar.gz')}, ['binding']);
    const project = path.join(tmp,'project');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project,'package.json'), JSON.stringify({name:'fixture',version:'1.0.0',main:'index.js',binary:{module_name:'fixture',module_path:'./installed',host:`file://${tmp}/`,package_name:'fixture.tar.gz'}}));
    execFileSync(process.execPath,[path.join(root,'node_modules/@mapbox/node-pre-gyp/bin/node-pre-gyp'),'install'],{cwd:project,stdio:'pipe'});
    assert.deepEqual(await fs.readFile(path.join(project,'installed/fixture.node')),payload);
    console.log('PASS node-pre-gyp: local prebuilt archive extracted unchanged');
    await fs.mkdir(path.join(source,'node/include/node'),{recursive:true});
    await fs.copyFile('/opt/homebrew/opt/node@22/include/node/node.h',path.join(source,'node/include/node/node.h'));
    await fs.copyFile('/opt/homebrew/opt/node@22/include/node/config.gypi',path.join(source,'node/include/node/config.gypi'));
    const headers = path.join(tmp,'headers.tar.gz');
    await tar.create({gzip:true,cwd:source,file:headers},['node']);
    execFileSync(process.execPath,[path.join(root,'node_modules/node-gyp/bin/node-gyp.js'),'install',`--target=${process.versions.node}`,`--tarball=${headers}`,`--devdir=${path.join(tmp,'headers')}`],{cwd:project,stdio:'pipe'});
    assert.deepEqual(await fs.readFile(path.join(tmp,'headers',process.versions.node,'include/node/node.h')),await fs.readFile('/opt/homebrew/opt/node@22/include/node/node.h'));
    console.log('PASS node-gyp: filtered local Node headers extracted unchanged');
  } finally { await fs.rm(tmp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e.stderr?.toString() || e);process.exitCode=1});
