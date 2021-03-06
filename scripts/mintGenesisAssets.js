const rocketh = require('rocketh');
const ethers = require('ethers');
const {BigNumber} = ethers;
const program = require('commander');
const request = require('request').defaults({jar: true}); // enable cookies
const {getValidator} = require('../lib/metadata');
const fs = require('fs');

function waitRequest(options) {
    return new Promise((resolve, reject) => {
        request(options, (error, response, body) => {
            if (error) {
                reject(error);
            } else if (body && body.error) {
                reject(body.error);
            } else {
                resolve({response, body});
            }
        });
    });
}

const base32Alphabet = [0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6A, 0x6B, 0x6C, 0x6D, 0x6E, 0x6F, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7A, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37];
function hash2base32(hash) { // TODO fix
    let _i = BigNumber.from(hash);
    let k = 52;
    const bstr = new Array(k);
    bstr[--k] = base32Alphabet[_i.mod(8).mul(4).mod(256)]; // uint8 s = uint8((256 - skip) % 5);  // (_i % (2**s)) << (5-s)
    _i = _i.div(8);
    while (k > 0) {
        bstr[--k] = base32Alphabet[_i.mod(32)];
        _i = _i.div(32);
    }
    return bstr.map((n) => String.fromCharCode(n)).join('');
}

async function getJSON(url) {
    const options = {
        method: 'GET',
        url,
        headers: {'Content-Type': 'application/json'},
        json: true
    };
    const res = await waitRequest(options);
    if (res && res.body) {
        return res.body;
    }
    throw new Error('nothing');
}

function compareArrays(arr1, arr2) {
    if (arr1.length !== arr2.length) {
        return false;
    }

    for (let i = 0, l = arr1.length; i < l; i++) {
        // Check if we have nested arrays
        if (arr1[i] instanceof Array && arr2[i] instanceof Array) {
            // recurse into the nested arrays
            if (!arr1[i].equals(arr2[i])) {
                return false;
            }
        } else if (arr1[i] !== arr2[i]) {
            // Warning - two different object instances will never be equal: {x:20} != {x:20}
            return false;
        }
    }
    return true;
}

const {
    sendTxAndWait,
    call,
    estimateGas,
} = rocketh;

const {
    genesisMinter
} = rocketh.namedAccounts;

// function hashFromCIDv1(cidv1) {
//     const decoder = new base32.Decoder();
//     const binary = decoder.write(cidv1.substr(1)).finalize().toString('hex');
//     return '0x' + binary.substr(8);
// }

function reportErrorAndExit(e) {
    console.error(e);
    process.exit(1);
}

function generateRaritiesPack(raritiesArr) {
    let raritiesPack = '0x';
    for (let i = 0; i < raritiesArr.length; i += 4) {
        let byteV = 0;
        for (let j = i; j < raritiesArr.length && j < i + 4; j++) {
            if (raritiesArr[j] > 3) {
                throw new Error('rarity > 3');
            }
            const p = Math.pow(2, ((3 - (j - i)) * 2));
            byteV += (raritiesArr[j] * p);
        }
        let s = byteV.toString(16);
        if (s.length === 1) {
            s = '0' + s;
        }
        raritiesPack += s;
    }
    return raritiesPack;
}

const credentials = JSON.parse(fs.readFileSync('.sandbox_credentials'));

async function mintBatch({
    validate,
    url,
    creator,
    options,
    assetIds,
    checks,
}) {
    const propertiesValues = {};
    const propertiesMaxValue = {};
    const testMode = !options.sendTx;
    const userData = await getJSON(url + '/users/' + creator);
    let creatorWallet;
    if (userData && userData.user) {
        creatorWallet = userData.user.Wallets[0].address; // TODO manage multiple wallet ?
    } else {
        throw new Error('no user with id ' + creator);
    }
    if (!creatorWallet) {
        throw new Error('no wallet for user with id ' + creator);
    }

    let destination = creatorWallet;
    if (options.destination) {
        destination = options.destination;
    }

    console.log('checking assetIds...');

    let i = 0;
    for (const assetId of assetIds) {
        const assetData = await getJSON(url + '/assets/' + assetId);
        if (assetData && assetData.asset) {
            if (assetData.asset.blockchainId) {
                throw new Error('Asset already minted ' + assetId);
            }
            if (assetData.asset.Creator.id !== creator) {
                throw new Error(`Asset with id ${assetId} does not belong to specified creator `);
            }

            const assetMetadataData = await getJSON(url + '/assets/' + assetId + '/metadata');
            if (!assetMetadataData.metadata) {
                reportErrorAndExit('no metadata for asset ' + assetId);
            }

            if (!validate(assetMetadataData.metadata)) {
                console.error(validate.errors);
                console.log(JSON.stringify(assetMetadataData.metadata, null, '  '));
                reportErrorAndExit('error in metadata, does not follow schema!');
            }

            // checks :
            // creator checks :
            if (assetMetadataData.metadata.sandbox.creator !== creatorWallet) {
                reportErrorAndExit(`creator wallet do not match, metadata (${assetMetadataData.metadata.sandbox.creator})  != wallet ${creatorWallet}`);
            }
            // checks values and rarity match
            let total = 0;
            let max = 0;
            if (assetMetadataData.metadata.properties.length !== 5) {
                reportErrorAndExit(`wrong number fo properties for asset ${assetId}`);
            }
            for (const property of assetMetadataData.metadata.properties) {
                if (property.value > max) {
                    max = property.value;
                }
                total += property.value;
            }
            propertiesMaxValue[assetId] = max;
            propertiesValues[assetId] = total;
        } else {
            throw new Error('no Asset with id ' + assetId);
        }
        i++;
    }

    console.log('getting mintInfo...');

    const reqOptions = {
        method: 'PATCH',
        url: url + '/assets/mintInfo',
        headers: {'Content-Type': 'application/json'},
        body: {
            assetIds,
            creatorId: creator
        },
        json: true
    };
    let assetBatchInfo;
    const assetBatchInfoRes = await waitRequest(reqOptions);
    if (assetBatchInfoRes && assetBatchInfoRes.body) {
        assetBatchInfo = assetBatchInfoRes.body;
    }

    console.log(JSON.stringify(assetBatchInfo, null, '  '));

    console.log('checking mintInfo...');

    if (assetBatchInfo) {
        // console.log(JSON.stringify(assetBatchInfo, null, '  '));
        const packId = options.packId || 0;
        const nonce = options.nonce;

        const gas = options.gas || 2000000; // TODO estimate

        const {supplies, hash} = assetBatchInfo;

        console.log('IPFS', 'ipfs://bafybei' + hash2base32(hash));
        const raritiesFromBackend = assetBatchInfo.rarities;
        const rarities = raritiesFromBackend.map((v) => v - 1);

        console.log(JSON.stringify(assetBatchInfo));

        for (let i = 0; i < assetIds.length; i++) {
            const assetId = assetIds[i];
            const rarity = rarities[i];
            const propertiesTotalValue = propertiesValues[assetId];
            const maxValue = propertiesMaxValue[assetId];
            let expectedValue = 0;
            let expectedMaxValue = 0;
            if (rarities[i] === 0) {
                expectedValue = 50;
                expectedMaxValue = 25;
            } else if (rarities[i] === 1) {
                expectedValue = 100;
                expectedMaxValue = 50;
            } else if (rarities[i] === 2) {
                expectedValue = 150;
                expectedMaxValue = 75;
            } else if (rarities[i] === 3) {
                expectedValue = 250;
                expectedMaxValue = 100;
            } else {
                reportErrorAndExit(`wrong rarity for asset ${assetId}`);
            }
            if (!(propertiesTotalValue === expectedValue)) {
                reportErrorAndExit(`asset ${assetId} with rarity ${rarity} got wrong total value ${propertiesTotalValue} it should be  ${expectedValue}`);
            }
            if (!(maxValue <= expectedMaxValue)) {
                reportErrorAndExit(`asset ${assetId} with rarity ${rarity} got wrong max value ${maxValue} it should be  ${expectedMaxValue}`);
            }
        }

        const raritiesPack = generateRaritiesPack(rarities);
        const suppliesArr = supplies;

        if (checks) {
            if (checks.creatorWallet && checks.creatorWallet.toLowerCase() !== creatorWallet.toLowerCase()) {
                reportErrorAndExit('creatorWallet not expected (expect ' + checks.creatorWallet + ' but got ' + creatorWallet + ')');
            }
            if (checks.hash && checks.hash.toLowerCase() !== hash.toLowerCase()) {
                reportErrorAndExit('hash not expected (expect ' + checks.hash + ' but got ' + hash + ')');
            }
            if (checks.supplies && !compareArrays(checks.supplies, supplies)) {
                reportErrorAndExit('supplies not expected (expect ' + checks.supplies + ' but got ' + supplies + ')');
            }
            if (checks.rarities && !compareArrays(checks.rarities.map((v) => v - 1), rarities)) {
                reportErrorAndExit('rarities not expected (expect ' + checks.rarities + ' but got ' + rarities + ')');
            }
        }

        const isPackIdUsed = await call('Asset', 'isPackIdUsed', creatorWallet, packId, suppliesArr.filter((n) => n > 1).length);
        if (isPackIdUsed) {
            reportErrorAndExit('pack id ' + packId + ' used');
        } else if (testMode) {
            console.log({genesisMinter, nonce, gas, creatorWallet, packId, hash, suppliesArr, raritiesPack, destination});
            let result;
            try {
                result = await estimateGas({from: genesisMinter, nonce, gas}, 'GenesisBouncer', 'mintMultipleFor', creatorWallet, packId, hash, suppliesArr, raritiesPack, destination);
            } catch (e) {
                reportErrorAndExit(e);
            }
            console.log('estimate', result.toString());
        } else {
            console.log({genesisMinter, nonce, gas, creatorWallet, packId, hash, suppliesArr, raritiesPack, destination});
            let result;
            try {
                result = await estimateGas({from: genesisMinter, nonce, gas}, 'GenesisBouncer', 'mintMultipleFor', creatorWallet, packId, hash, suppliesArr, raritiesPack, destination);
            } catch (e) {
                reportErrorAndExit(e);
            }
            console.log('estimate', result.toString());
            try {
                const receipt = await sendTxAndWait({from: genesisMinter, nonce, gas}, 'GenesisBouncer', 'mintMultipleFor', creatorWallet, packId, hash, suppliesArr, raritiesPack, destination);
                console.log('success', {txHash: receipt.transactionHash, gasUsed: receipt.gasUsed});
            } catch (e) {
                reportErrorAndExit(e);
            }
        }
    } else {
        console.error('no info for ', assetIds);
    }
}

// const schemaS = fs.readFileSync(path.join(__dirname, 'assetMetadataSchema.json'));
// const schema = JSON.parse(schemaS);
// const ajv = new Ajv(); // options can be passed, e.g. {allErrors: true}

program
    .command('mintIds <creator> <assetIds...>')
    .description('mint assets from ids')
    .option('-u, --url <url>', 'api url')
    .option('-w, --webUrl <webUrl>', 'web url')
    .option('-g, --gas <gas>', 'gas limit')
    .option('-p, --packId <packId>', 'packId')
    .option('-n, --nonce <nonce>', 'nonce')
    .option('-t, --sendTx', 'send tx')
    .option('-d, --destination', 'destination')
    .action(async (creator, assetIds, cmdObj) => {
        let webUrl = (cmdObj.webUrl || 'http://localhost:8081');
        let url = (cmdObj.url || 'http://localhost:8081');
        console.log({url, webUrl});
        if (url === 'production') {
            url = 'https://api.sandbox.game';
            webUrl = 'https://www.sandbox.game';
        } else if (url === 'dev' || url === 'development') {
            url = 'https://api-develop.sandbox.game';
            webUrl = 'https://develop.sandbox.game';
        } else if (url === 'staging') {
            url = 'https://api-stage.sandbox.game';
            webUrl = 'https://stage.sandbox.game';
        } else if (url === 'preprod') {
            url = 'https://api-preprod.sandbox.game';
            webUrl = 'https://www.sandbox.game';
        }

        console.log({url, webUrl});
        await waitRequest({
            method: 'POST',
            url: url + '/auth/login',
            body: credentials,
            json: true
        });

        const validate = getValidator(webUrl);
        await mintBatch({
            validate,
            url,
            creator,
            options: {
                destination: cmdObj.destination,
                nonce: cmdObj.nonce,
                sendTx: cmdObj.sendTx,
                packId: cmdObj.packId,
                gas: cmdObj.gas,
            },
            assetIds,
        });
    });

program
    .command('mintJson <jsonPath>')
    .description('mint assets from json')
    .option('-u, --url <url>', 'api url')
    .option('-w, --webUrl <webUrl>', 'web url')
    .option('-g, --gas <gas>', 'gas limit')
    .option('-t, --sendTx', 'send tx')
    .action(async (jsonPath, cmdObj) => {
        let webUrl = (cmdObj.webUrl || 'http://localhost:8081');
        let url = (cmdObj.url || 'http://localhost:8081');
        console.log({url, webUrl});
        if (url === 'production') {
            url = 'https://api.sandbox.game';
            webUrl = 'https://www.sandbox.game';
        } else if (url === 'dev' || url === 'development') {
            url = 'https://api-develop.sandbox.game';
            webUrl = 'https://develop.sandbox.game';
        } else if (url === 'staging') {
            url = 'https://api-stage.sandbox.game';
            webUrl = 'https://stage.sandbox.game';
        } else if (url === 'preprod') {
            url = 'https://api-preprod.sandbox.game';
            webUrl = 'https://www.sandbox.game';
        }

        console.log({url, webUrl});
        await waitRequest({
            method: 'POST',
            url: url + '/auth/login',
            body: credentials,
            json: true
        });

        const validate = getValidator(webUrl);

        const batches = JSON.parse(fs.readFileSync(jsonPath));
        for (const batch of batches) {
            await mintBatch({
                validate,
                url,
                creator: batch.creatorId,
                options: {
                    destination: cmdObj.destination,
                    nonce: cmdObj.nonce,
                    sendTx: cmdObj.sendTx,
                    packId: batch.packId || cmdObj.packId,
                    gas: batch.gas || cmdObj.gas,
                },
                assetIds: batch.assetIds,
                checks: {
                    creatorWallet: batch.address,
                    hash: batch.hash,
                    supplies: batch.supplies,
                    rarities: batch.rarities,
                }
            });
        }
    });

program.parse(process.argv);
