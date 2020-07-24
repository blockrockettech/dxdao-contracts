/**
    helpers for tests
*/

const Avatar = artifacts.require("./Avatar.sol");
const Controller = artifacts.require("./Controller.sol");
const DAOToken = artifacts.require("./DAOToken.sol");
const Reputation = artifacts.require("./Reputation.sol");
const AbsoluteVote = artifacts.require("./AbsoluteVote.sol");
const GenesisProtocol = artifacts.require("./GenesisProtocol.sol");
const WalletScheme = artifacts.require("./WalletScheme.sol");
const ActionMock = artifacts.require("./ActionMock.sol");
const constants = require("./constants");
const { encodePermission, decodePermission } = require("./permissions");
const { encodeGenericCallData } = require("./walletScheme");
const EthDecoder = require("@maticnetwork/eth-decoder")

const logDecoder = new EthDecoder.default.LogDecoder(
  [
    Avatar.abi,
    Controller.abi,
    DAOToken.abi,
    Reputation.abi,
    AbsoluteVote.abi,
    GenesisProtocol.abi,
    WalletScheme.abi
  ]
);

const txDecoder = new EthDecoder.default.TxDecoder(
  [
    Avatar.abi,
    Controller.abi,
    DAOToken.abi,
    Reputation.abi,
    AbsoluteVote.abi,
    GenesisProtocol.abi,
    WalletScheme.abi
  ]
);

const MAX_UINT_256 = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const NULL_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SOME_HASH = "0x1000000000000000000000000000000000000000000000000000000000000000";
const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";
const SOME_ADDRESS = "0x1000000000000000000000000000000000000000";


const getProposalAddress = function(tx) {
  // helper function that returns a proposal object from the ProposalCreated event
  // in the logs of tx
  assert.equal(tx.logs[ 0 ].event, "ProposalCreated");
  const proposalAddress = tx.logs[ 0 ].args.proposaladdress;
  return proposalAddress;
}

const getValueFromLogs = function(tx, arg, eventName, index = 0) {
  /**
   *
   * tx.logs look like this:
   *
   * [ { logIndex: 13,
   *     transactionIndex: 0,
   *     transactionHash: '0x999e51b4124371412924d73b60a0ae1008462eb367db45f8452b134e5a8d56c8',
   *     blockHash: '0xe35f7c374475a6933a500f48d4dfe5dce5b3072ad316f64fbf830728c6fe6fc9',
   *     blockNumber: 294,
   *     address: '0xd6a2a42b97ba20ee8655a80a842c2a723d7d488d',
   *     type: 'mined',
   *     event: 'NewOrg',
   *     args: { _avatar: '0xcc05f0cde8c3e4b6c41c9b963031829496107bbb' } } ]
   */
  if (!tx.logs || !tx.logs.length) {
    throw new Error("getValueFromLogs: Transaction has no logs");
  }

  if (eventName !== undefined) {
    for (let i = 0; i < tx.logs.length; i++) {
      if (tx.logs[ i ].event  === eventName) {
        index = i;
        break;
      }
    }
    if (index === undefined) {
      let msg = `getValueFromLogs: There is no event logged with eventName ${eventName}`;
      throw new Error(msg);
    }
  } else {
    if (index === undefined) {
      index = tx.logs.length - 1;
    }
  }
  let result = tx.logs[ index ].args[ arg ];
  if (!result) {
    let msg = `getValueFromLogs: This log does not seem to have a field "${arg}": ${tx.logs[ index ].args}`;
    throw new Error(msg);
  }
  return result;
}

const getProposal = async function(tx) {
  return await Proposal.at(getProposalAddress(tx));
}

const etherForEveryone = async function(accounts) {
  // give all web3.eth.accounts some ether
  for (let i = 0; i < 10; i++) {
    await web3.eth.sendTransaction({to: accounts[ i ], from: accounts[ 0 ], value: web3.utils.toWei("0.1", "ether")});
  }
}

const outOfGasMessage = "VM Exception while processing transaction: out of gas";

const assertJumpOrOutOfGas = function(error) {
  let condition = (
    error.message === outOfGasMessage ||
        error.message.search("invalid JUMP") > -1
  );
  assert.isTrue(condition, "Expected an out-of-gas error or an invalid JUMP error, got this instead: " + error.message);
}

const assertVMException = function(error) {
  let condition = (
    error.message.search("VM Exception") > -1
  );
  assert.isTrue(condition, "Expected a VM Exception, got this instead:" + error.message);
}

const assertInternalFunctionException = function(error) {
  let condition = (
    error.message.search("is not a function") > -1
  );
  assert.isTrue(condition, "Expected a function not found Exception, got this instead:" + error.message);
}

const assertJump = function(error) {
  assert.isAbove(error.message.search("invalid JUMP"), -1, "Invalid JUMP error must be returned" + error.message);
}

const setupAbsoluteVote = async function(voteOnBehalf = NULL_ADDRESS, precReq = 50 ) {
  const absoluteVote = await AbsoluteVote.new();
  // register some parameters
  absoluteVote.setParameters( precReq, voteOnBehalf);
  const params = await absoluteVote.getParametersHash( precReq, voteOnBehalf);
  return { address: absoluteVote.address, contract: absoluteVote, params };
};

const setupGenesisProtocol = async function(
  accounts,
  token,
  avatar,
  voteOnBehalf = NULL_ADDRESS,
  _queuedVoteRequiredPercentage = 50,
  _queuedVotePeriodLimit = 60,
  _boostedVotePeriodLimit = 60,
  _preBoostedVotePeriodLimit = 0,
  _thresholdConst = 2000,
  _quietEndingPeriod = 0,
  _proposingRepReward = 60,
  _votersReputationLossRatio = 10,
  _minimumDaoBounty = 15,
  _daoBountyConst = 10,
  _activationTime = 0
) {
  const genesisProtocol = await GenesisProtocol.new(token, {gas: constants.ARC_GAS_LIMIT});

  // set up a reputation system
  const reputationArray = [ 20, 10, 70 ];
  // register some parameters
  genesisProtocol.setParameters([ _queuedVoteRequiredPercentage,
    _queuedVotePeriodLimit,
    _boostedVotePeriodLimit,
    _preBoostedVotePeriodLimit,
    _thresholdConst,
    _quietEndingPeriod,
    _proposingRepReward,
    _votersReputationLossRatio,
    _minimumDaoBounty,
    _daoBountyConst,
    _activationTime ], voteOnBehalf);
  const params = await genesisProtocol.getParametersHash([ _queuedVoteRequiredPercentage,
    _queuedVotePeriodLimit,
    _boostedVotePeriodLimit,
    _preBoostedVotePeriodLimit,
    _thresholdConst,
    _quietEndingPeriod,
    _proposingRepReward,
    _votersReputationLossRatio,
    _minimumDaoBounty,
    _daoBountyConst,
    _activationTime ], voteOnBehalf);

  return {address: genesisProtocol.address, contract: genesisProtocol, reputationArray, params};
};

const setupOrganizationWithArrays = async function(
  daoCreator, daoCreatorOwner, founderToken, founderReputation, cap = 0
) {
  var tx = await daoCreator.forgeOrg(
    "testOrg",
    "TEST",
    "TST",
    daoCreatorOwner,
    founderToken,
    founderReputation,
    cap,
    {gas: constants.ARC_GAS_LIMIT}
  );
  assert.equal(tx.logs.length, 1);
  assert.equal(tx.logs[ 0 ].event, "NewOrg");
  const avatar = await Avatar.at(tx.logs[ 0 ].args._avatar);
  const token = await DAOToken.at(await avatar.nativeToken());
  const reputation = await Reputation.at(await avatar.nativeReputation());
  const controller = await Controller.at(await avatar.owner());
  return {avatar, token, reputation, controller};
};

const setupOrganization = async function(
  daoCreator, daoCreatorOwner, founderToken, founderReputation, cap = 0
) {
  var tx = await daoCreator.forgeOrg(
    "testOrg",
    "TEST",
    "TST",
    [ daoCreatorOwner ],
    [ founderToken ],
    [ founderReputation ],
    cap,
    {gas: constants.ARC_GAS_LIMIT}
  );
  assert.equal(tx.logs.length, 1);
  assert.equal(tx.logs[ 0 ].event, "NewOrg");
  const avatar = await Avatar.at(tx.logs[ 0 ].args._avatar);
  const token = await DAOToken.at(await avatar.nativeToken());
  const reputation = await Reputation.at(await avatar.nativeReputation());
  const controller = await Controller.at(await avatar.owner());
  return { avatar, token, reputation, controller};
};


const checkVoteInfo = async function(absoluteVote, proposalId, voterAddress, _voteInfo) {
  let voteInfo;
  voteInfo = await absoluteVote.voteInfo(proposalId, voterAddress);
  // voteInfo has the following structure
  // int256 vote;
  assert.equal(voteInfo[ 0 ].toNumber(), _voteInfo[ 0 ]);
  // uint256 reputation;
  assert.equal(voteInfo[ 1 ].toNumber(), _voteInfo[ 1 ]);
};

const checkVotesStatus = async function(proposalId, _votesStatus, votingMachine){

  let voteStatus;
  for (var i = 0; i < _votesStatus.length; i++) {
    voteStatus = await votingMachine.voteStatus(proposalId, i);
    assert.equal(voteStatus, _votesStatus[ i ]);
  }
};

const getProposalId = async function(tx, contract, eventName) {
  var proposalId;
  await contract.getPastEvents(eventName, {
    fromBlock: tx.blockNumber,
    toBlock: "latest"
  })
    .then(function(events){
      proposalId = events[ 0 ].args._proposalId;
    });
  return proposalId;
}

// Increases testrpc time by the passed duration in seconds
const increaseTime = async function(duration) {
  const id = await Date.now();

  web3.providers.HttpProvider.prototype.sendAsync = web3.providers.HttpProvider.prototype.send;

  return new Promise((resolve, reject) => {
    web3.currentProvider.sendAsync({
      jsonrpc: "2.0",
      method: "evm_increaseTime",
      params: [ duration ],
      id: id,
    }, err1 => {
      if (err1) return reject(err1);

      web3.currentProvider.sendAsync({
        jsonrpc: "2.0",
        method: "evm_mine",
        id: id + 1,
      }, (err2, res) => {
        return err2 ? reject(err2) : resolve(res);
      });
    });
  });
};

const testCallFrom = function(address) {
  return new web3.eth.Contract(ActionMock.abi).methods.test(address).encodeABI();
}
const testCallWithoutReturnValueFrom = function(address) {
  return new web3.eth.Contract(ActionMock.abi).methods.testWithoutReturnValue(address).encodeABI();
}

module.exports = { 
  logDecoder,
  txDecoder,
  MAX_UINT_256,
  NULL_HASH,
  SOME_HASH,
  NULL_ADDRESS,
  SOME_ADDRESS,
  getProposalAddress,
  getValueFromLogs,
  getProposal,
  etherForEveryone,
  assertJumpOrOutOfGas,
  assertVMException,
  assertInternalFunctionException,
  assertJump,
  setupAbsoluteVote,
  setupGenesisProtocol,
  setupOrganizationWithArrays,
  setupOrganization,
  checkVoteInfo,
  checkVotesStatus,
  testCallFrom,
  testCallWithoutReturnValueFrom,
  getProposalId,
  increaseTime,
  encodePermission,
  decodePermission,
  encodeGenericCallData
};
