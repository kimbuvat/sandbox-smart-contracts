const fetch = require('node-fetch');
const ipfsClient = require('ipfs-http-client');
const fs = require('fs');
const path = require('path');
const program = require('commander');

program
    .command('publish <path>')
    .option('-t, --test', 'only hash')
    .option('-d, --dev', 'dev')
    .description('publish to ipfs')
    .action(async (folderPath, cmdObj) => {
        const dev = cmdObj.dev;
        let tokenFileS;
        let jsonResponse;
        try {
            tokenFileS = fs.readFileSync('.' + (dev ? 'dev_' : '') + 'temporal_token').toString();
        } catch (e) {

        }

        if (tokenFileS) {
            jsonResponse = JSON.parse(tokenFileS);
        }
        if (!jsonResponse || Date.now() > (new Date(jsonResponse.expire).getTime() + (20 * 60 * 60 * 1000))) {
            console.log('renewing token...');
            let response;
            try {
                response = await fetch(dev ? 'https://dev.api.temporal.cloud/v2/auth/login' : 'https://api.temporal.cloud/v2/auth/login', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'text/plain'
                    },
                    body: JSON.stringify({
                        username: 'TheSandbox',
                        password: fs.readFileSync('.temporal').toString(),
                    })
                });
            } catch (e) {
                console.error('fetch', e);
                process.exit(1);
            }
            try {
                jsonResponse = await response.json();
            } catch (e) {
                console.error('response.json', e);
                process.exit(1);
            }
            fs.writeFileSync('.temporal_token', JSON.stringify(jsonResponse));
        }
        const jwt = jsonResponse.token.toString();
        await upload(jwt, {test: cmdObj.test, folderPath, dev: cmdObj.dev});
    });

function traverse(dir, result = [], topDir) {
    fs.readdirSync(dir).forEach((name) => {
        const fPath = path.resolve(dir, name);
        const stats = fs.statSync(fPath);
        const fileStats = {name, path: fPath, relativePath: path.relative(topDir || dir, fPath), mtimeMs: stats.mtimeMs, directory: stats.isDirectory()};
        if (fileStats.directory) {
            result.push(fileStats);
            return traverse(fPath, result, topDir || dir);
        }
        result.push(fileStats);
    });
    return result;
}

async function upload(jwt, {test, folderPath, dev}) {
    const ipfsConfig = {
        host: dev ? 'dev.api.ipfs.temporal.cloud' : 'api.ipfs.temporal.cloud',
        port: '443',
        'api-path': '/api/v0/',
        protocol: 'https',
        headers: {
            authorization: 'Bearer ' + jwt
        }
    };
    const ipfs = ipfsClient(ipfsConfig);

    const filesInFolder = traverse(folderPath);
    const files = [{
        path: './'
    }];
    for (const file of filesInFolder) {
        if (file.isDirectory) {
            files.push({
                path: file.relativePath,
            });
        } else {
            const buffer = fs.readFileSync(file.path);
            files.push({
                path: file.relativePath,
                content: buffer.toString(),
            });
        }
    }

    const options = {
        cidVersion: 1,
        // cidBase: 'base32',
        onlyHash: test,
        // recursive: true,
        // wrapWithDirectory : true,
    };

    // await ipfs.add(files, options, (e, res) => {
    //     if (e) {
    //         console.error('ipfs.add', e);
    //         ipfsConfig.headers.authorization = ipfsConfig.headers.authorization.substr(0, 7) + '<jwt>';
    //         console.log('IPFS CONFIG', JSON.stringify(ipfsConfig, null, '  '));
    //         console.log('FILES', JSON.stringify(files, null, '  '));
    //         console.log('OPTIONS', JSON.stringify(options, null, '  '));
    //     } else {
    //         console.log(JSON.stringify(res, null, '  '));
    //     }
    // });

    try {
        const res = await ipfs.add(
            files,
            options
        );
        console.log(JSON.stringify(res, null, '  '));
    } catch (e) {
        console.error('ipfs.add', e);
        ipfsConfig.headers.authorization = ipfsConfig.headers.authorization.substr(0, 7) + '<jwt>';
        console.log('IPFS CONFIG', JSON.stringify(ipfsConfig, null, '  '));
        console.log('FILES', JSON.stringify(files, null, '  '));
        console.log('OPTIONS', JSON.stringify(options, null, '  '));
    }
}

program.parse(process.argv);
