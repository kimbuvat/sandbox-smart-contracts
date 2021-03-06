const {guard} = require('../lib');

module.exports = async ({namedAccounts, initialRun, getDeployedContract, deployIfDifferent}) => {
    function log(...args) {
        if (initialRun) {
            console.log(...args);
        }
    }

    const {
        deployer,
        assetAuctionAdmin,
        assetAuctionFeeCollector
    } = namedAccounts;

    const assetAuctionFee10000th = 0; // 5000; // 5%

    const asset = getDeployedContract('Asset');
    if (!asset) {
        throw new Error('no Asset contract deployed');
    }
    const sandContract = getDeployedContract('Sand');
    if (!sandContract) {
        throw new Error('no SAND contract deployed');
    }

    const deployResult = await deployIfDifferent(['data'],
        'AssetSignedAuction',
        {from: deployer, gas: 4000000},
        'AssetSignedAuction',
        asset.address,
        assetAuctionAdmin,
        sandContract.address,
        assetAuctionFeeCollector,
        assetAuctionFee10000th
    );
    if (deployResult.newlyDeployed) {
        log(' - AssetSignedAuction deployed at : ' + deployResult.contract.address + ' for gas : ' + deployResult.receipt.gasUsed);
    } else {
        log('reusing AssetSignedAuction at ' + deployResult.contract.address);
    }
};
module.exports.skip = guard(['1', '4', '314159'], 'AssetSignedAuction');
