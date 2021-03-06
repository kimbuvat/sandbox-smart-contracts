const rocketh = require('rocketh');
const {getDeployedContract} = require('../../lib');
const {runERC721tests} = require('../erc721_tests');
const {runQuadTreeTests} = require('./quadtree_tests');

const {
    tx,
    gas,
    emptyBytes,
} = require('../utils');

const {
    deployer,
    landAdmin,
} = rocketh.namedAccounts;

async function deployLand() {
    await rocketh.runStages();
    return getDeployedContract('Land');
}

function ERC721Contract() {
    this.counter = 0;
    this.contract = null;
    this.minter = deployer;
    this.supportsBatchTransfer = true;
    this.supportsSafeBatchTransfer = true;
    this.supportsMandatoryERC721Receiver = true;
}
ERC721Contract.prototype.resetContract = async function () {
    this.contract = await deployLand();
    await tx(this.contract, 'setMinter', {from: landAdmin, gas}, this.minter, true);
    return this.contract;
};
ERC721Contract.prototype.mintERC721 = async function (creator) {
    this.counter++;
    const receipt = await tx(this.contract, 'mintQuad', {from: this.minter, gas}, creator, 1, this.counter, this.counter, emptyBytes); // diagonal
    return receipt.events.Transfer.returnValues._tokenId;
};
ERC721Contract.prototype.burnERC721 = function (from, tokenId) {
    return this.contract.methods.burnFrom(from, tokenId).send({from, gas: 3000000});
};

runQuadTreeTests('Land', new ERC721Contract());
runERC721tests('Land', new ERC721Contract());
