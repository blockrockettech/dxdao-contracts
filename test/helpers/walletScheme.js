const Avatar = artifacts.require("./Avatar.sol");
const Controller = artifacts.require("./Controller.sol");

const encodeGenericCallData = function(avatar, to, data, value) {
  return new web3.eth.Contract(Controller.abi).methods
    .genericCall(to, data, avatar, value).encodeABI();
};

module.exports = { encodeGenericCallData };
