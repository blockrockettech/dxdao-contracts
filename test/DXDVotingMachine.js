import * as helpers from "./helpers";
const constants = require("./helpers/constants");
const WalletScheme = artifacts.require("./WalletScheme.sol");
const DaoCreator = artifacts.require("./DaoCreator.sol");
const DxControllerCreator = artifacts.require("./DxControllerCreator.sol");
const ERC20Mock = artifacts.require("./ERC20Mock.sol");
const ActionMock = artifacts.require("./ActionMock.sol");
const Wallet = artifacts.require("./Wallet.sol");
const DXDVotingMachine = artifacts.require("./DXDVotingMachine.sol");
const { toEthSignedMessageHash, fixSignature } = require('./helpers/sign');
const BN = web3.utils.BN;

const ProposalState = {
  submitted: 0,
  passed: 1,
  failed: 2,
  executed: 3
};

contract("DXDVotingMachine", function(accounts) {
  let standardTokenMock,
    expensiveVoteWalletScheme,
    cheapVoteWalletScheme,
    walletScheme,
    org,
    actionMock,
    genVotingMachine,
    dxdVotingMachine,
    proposalId
  
  const TEST_VALUE = 123;
  const TEST_HASH = helpers.SOME_HASH;
  const GAS_PRICE = 10000000000;
  const VOTE_GAS = 360000;
  const TOTAL_GAS_REFUND = VOTE_GAS * GAS_PRICE;
  
  function testCallFrom(address) {
    return new web3.eth.Contract(ActionMock.abi).methods.test(address).encodeABI();
  }
  
  function decodeGenericCallError(genericCallDataReturn) {
    assert.equal(genericCallDataReturn.substring(0,10), web3.eth.abi.encodeFunctionSignature('Error(string)'));
    const errorMsgBytesLength = web3.utils.hexToNumber('0x'+genericCallDataReturn.substring(74, 138))*2;
    return web3.utils.hexToUtf8('0x' + genericCallDataReturn.substring(138, 138 + errorMsgBytesLength));
  }
  
  beforeEach( async function(){
    actionMock = await ActionMock.new();
    const standardTokenMock = await ERC20Mock.new(accounts[1], 1000);
    const controllerCreator = await DxControllerCreator.new({gas: constants.ARC_GAS_LIMIT});
    const daoCreator = await DaoCreator.new(
      controllerCreator.address, {gas: constants.ARC_GAS_LIMIT}
    );
    org = await helpers.setupOrganizationWithArrays(
      daoCreator,
      [accounts[0], accounts[1], accounts[2]],
      [1000, 1000, 1000],
      [20, 10, 70]
    );
    
    genVotingMachine = await helpers.setupGenesisProtocol(
      accounts, standardTokenMock.address, 'normal', helpers.NULL_ADDRESS
    );
    dxdVotingMachine = await helpers.setupGenesisProtocol(
      accounts, standardTokenMock.address, 'dxd', helpers.NULL_ADDRESS
    );
    
    expensiveVoteWalletScheme = await WalletScheme.new();
    await expensiveVoteWalletScheme.initialize(
      org.avatar.address,
      genVotingMachine.address,
      genVotingMachine.params,
      org.controller.address
    );
    
    cheapVoteWalletScheme = await WalletScheme.new();
    await cheapVoteWalletScheme.initialize(
      org.avatar.address,
      dxdVotingMachine.address,
      dxdVotingMachine.params,
      org.controller.address
    );
    
    await daoCreator.setSchemes(
      org.avatar.address,
      [expensiveVoteWalletScheme.address, cheapVoteWalletScheme.address],
      [genVotingMachine.params, dxdVotingMachine.params],
      [helpers.encodePermission({
          canGenericCall: true,
          canUpgrade: true,
          canChangeConstraints: true,
          canRegisterSchemes: true
        }),
        helpers.encodePermission({
          canGenericCall: true,
          canUpgrade: true,
          canChangeConstraints: true,
          canRegisterSchemes: true
        }),
     ],
      "metaData"
    );
    
  });
  
  describe('Payable Votes', function() {
    
    beforeEach( async function() {
      await web3.eth.sendTransaction({
        from: accounts[0], to: org.avatar.address, value: web3.utils.toWei('1')
      });
      const setRefundConfData = new web3.eth.Contract(DXDVotingMachine.abi).methods.setOrganizationRefund(
        VOTE_GAS, GAS_PRICE
      ).encodeABI();
      const setRefundConfTx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address], 
        [helpers.encodeGenericCallData(
          org.avatar.address, dxdVotingMachine.address, setRefundConfData, 0
        )],
        [0],
        TEST_HASH
      );
      const setRefundConfProposalId = await helpers.getValueFromLogs(setRefundConfTx, "_proposalId");
      const organizationId = (await dxdVotingMachine.contract.proposals(setRefundConfProposalId)).organizationId
      assert.equal(await dxdVotingMachine.contract.organizations(organizationId), org.avatar.address);
      await dxdVotingMachine.contract.vote(setRefundConfProposalId, 1, 0, helpers.NULL_ADDRESS, {from: accounts[2]});
      await cheapVoteWalletScheme.execute(setRefundConfProposalId);
      const organizationRefundConf = await dxdVotingMachine.contract.organizationRefunds(org.avatar.address);
      assert.equal(0, organizationRefundConf.balance);
      assert.equal(VOTE_GAS, organizationRefundConf.voteGas);
      assert.equal(GAS_PRICE, organizationRefundConf.maxGasPrice);
    })
    
    it("gas spent in PayableGenesisProtocol vote is less than GenesisProtocol vote", async function() {  
      await web3.eth.sendTransaction({from: accounts[0], to: org.avatar.address, value: web3.utils.toWei('1')});
      const fundVotingMachineTx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address], 
        [helpers.encodeGenericCallData(org.avatar.address, dxdVotingMachine.address, '0x0', web3.utils.toWei('1'))],
        [0],
        TEST_HASH
      );
      const fundVotingMachineProposalId = await helpers.getValueFromLogs(fundVotingMachineTx, "_proposalId");
      await dxdVotingMachine.contract.vote(
        fundVotingMachineProposalId, 1, 0, helpers.NULL_ADDRESS, {from: accounts[2]}
      );
      await cheapVoteWalletScheme.execute(fundVotingMachineProposalId);
      
      const genericCallData = helpers.encodeGenericCallData(
        org.avatar.address, actionMock.address, testCallFrom(org.avatar.address), 0
      );
      
      let tx = await expensiveVoteWalletScheme.proposeCalls(
        [org.controller.address], [genericCallData], [0], TEST_HASH
      );
      let proposalId = await helpers.getValueFromLogs(tx, "_proposalId");
      let balanceBeforeVote = new BN(await web3.eth.getBalance(accounts[2]));
      tx = await genVotingMachine.contract.vote(
        proposalId, 1, 0, helpers.NULL_ADDRESS, {from: accounts[2], gasPrice: GAS_PRICE}
      );
      let balanceAfterVote = new BN(await web3.eth.getBalance(accounts[2]));
      const gastVoteWithoutRefund = parseInt(balanceBeforeVote.sub(balanceAfterVote).div(new BN(GAS_PRICE)).toString())
      expect(tx.receipt.gasUsed).to.be.closeTo(gastVoteWithoutRefund, 1);

      await expensiveVoteWalletScheme.execute(proposalId);  
      let organizationProposal = await expensiveVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.executed);
      assert.equal(organizationProposal.callData[0], genericCallData);
      assert.equal(organizationProposal.to[0], org.controller.address);
      assert.equal(organizationProposal.value[0], 0);
      
      // Vote with refund configured
      tx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address], [genericCallData], [0], TEST_HASH
      );
      proposalId = await helpers.getValueFromLogs(tx, "_proposalId");
      balanceBeforeVote = new BN(await web3.eth.getBalance(accounts[2]));
      tx = await dxdVotingMachine.contract.vote(
        proposalId, 1, 0, helpers.NULL_ADDRESS, {from: accounts[2], gasPrice: GAS_PRICE}
      );
      balanceAfterVote = new BN(await web3.eth.getBalance(accounts[2]));
      const gasVoteWithRefund = parseInt(balanceBeforeVote.sub(balanceAfterVote).div(new BN(GAS_PRICE)).toString());
      
      // Gas was taken from the organization refund balance and used to pay most of vote gas cost
      assert.equal(web3.utils.toWei('1') - TOTAL_GAS_REFUND,
        (await dxdVotingMachine.contract.organizationRefunds(org.avatar.address)).balance
      )
      expect(tx.receipt.gasUsed - VOTE_GAS).to.be.closeTo(gasVoteWithRefund, 1);

      await cheapVoteWalletScheme.execute(proposalId);
      organizationProposal = await cheapVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.executed);
      assert.equal(organizationProposal.callData[0], genericCallData);
      assert.equal(organizationProposal.to[0], org.controller.address);
      assert.equal(organizationProposal.value[0], 0);
    });
    
    
    it("pay for gasRefund from voting machine only when gasRefund balance is enough", async function() {
      // Send enough eth just for two votes
      const votesRefund = TOTAL_GAS_REFUND * 2;
      await web3.eth.sendTransaction({from: accounts[0], to: org.avatar.address, value: votesRefund.toString()});
      const fundVotingMachineTx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address], 
        [helpers.encodeGenericCallData(
          org.avatar.address, dxdVotingMachine.address, '0x0', votesRefund.toString()
        )],
        [0],
        TEST_HASH
      );
      const fundVotingMachineProposalId = await helpers.getValueFromLogs(fundVotingMachineTx, "_proposalId");
      await dxdVotingMachine.contract.vote(
        fundVotingMachineProposalId, 1, 0, helpers.NULL_ADDRESS, {from: accounts[2], gasPrice: GAS_PRICE}
      );
      await cheapVoteWalletScheme.execute(fundVotingMachineProposalId);
      
      // Vote three times and pay only the first two
      const genericCallData = helpers.encodeGenericCallData(
        org.avatar.address, actionMock.address, testCallFrom(org.avatar.address), 0
      );
      let tx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address], [genericCallData], [0], TEST_HASH
      );
      let proposalId = await helpers.getValueFromLogs(tx, "_proposalId");
      assert.equal(TOTAL_GAS_REFUND * 2,
        Number((await dxdVotingMachine.contract.organizationRefunds(org.avatar.address)).balance)
      )
      // Vote with higher gas than maxGasPrice and dont spend more than one vote refund
      await dxdVotingMachine.contract.vote(
        proposalId, 2, 0, helpers.NULL_ADDRESS, {from: accounts[0], gasPrice: GAS_PRICE*2}
      );
      
      assert.equal(TOTAL_GAS_REFUND,
        Number((await dxdVotingMachine.contract.organizationRefunds(org.avatar.address)).balance)
      )
      await dxdVotingMachine.contract.vote(
        proposalId, 2, 0, helpers.NULL_ADDRESS, {from: accounts[1], gasPrice: GAS_PRICE}
      );
      
      assert.equal(0,
        Number((await dxdVotingMachine.contract.organizationRefunds(org.avatar.address)).balance)
      )
      const balanceBeforeVote = new BN(await web3.eth.getBalance(accounts[2]));
      tx = await dxdVotingMachine.contract.vote(
        proposalId, 1, 0, helpers.NULL_ADDRESS, {from: accounts[2], gasPrice: GAS_PRICE}
      );
      const balanceAfterVote = new BN(await web3.eth.getBalance(accounts[2]));
    
      // There wasnt enough gas balance in the voting machine to pay the gas refund of the last vote
      const gastVoteWithoutRefund = parseInt(balanceBeforeVote.sub(balanceAfterVote).div(new BN(GAS_PRICE)).toString());
      expect(tx.receipt.gasUsed).to.be.closeTo(gastVoteWithoutRefund, 1);
      
      await cheapVoteWalletScheme.execute(proposalId);
      const organizationProposal = await cheapVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.executed);
      assert.equal(organizationProposal.callData[0], genericCallData);
      assert.equal(organizationProposal.to[0], org.controller.address);
      assert.equal(organizationProposal.value[0], 0);
    });
  });
  
  describe('Signed Votes', function() {
  
    beforeEach( async function(){
      const wallet = await Wallet.new();
      await web3.eth.sendTransaction({
        from: accounts[0], to: org.avatar.address, value: TEST_VALUE
      });
      await wallet.transferOwnership(org.avatar.address);
    
      const genericCallDataTransfer = helpers.encodeGenericCallData(
        org.avatar.address, wallet.address, "0x0", TEST_VALUE
      );
      const payCallData = await new web3.eth.Contract(wallet.abi).methods.pay(accounts[1]).encodeABI();
      const genericCallDataPay = helpers.encodeGenericCallData(
        org.avatar.address, wallet.address, payCallData, 0
      );
      const callDataMintRep = await org.controller.contract.methods.mintReputation(
        TEST_VALUE,
        accounts[4],
        org.avatar.address
      ).encodeABI();
    
      const tx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address, org.controller.address, org.controller.address],
        [genericCallDataTransfer, genericCallDataPay, callDataMintRep],
        [0, 0, 0],
        TEST_HASH
      );
      proposalId = await helpers.getValueFromLogs(tx, "_proposalId");
    })
          
    it("fail sharing ivalid vote signature", async function() {
      const voteHash = await dxdVotingMachine.contract.hashVote(
        dxdVotingMachine.address, proposalId, accounts[2], 1, 70
      );
      const votesignature = fixSignature(await web3.eth.sign(voteHash, accounts[2]));  
      assert.equal(accounts[2], web3.eth.accounts.recover(voteHash, votesignature));
      
      try {
        await dxdVotingMachine.contract.shareSignedVote(
          dxdVotingMachine.address, proposalId, 2, 70, votesignature, {from: accounts[2]}
        );
        assert(false, "cannot share invalid vote signature different vote");
      } catch(error) { helpers.assertVMException(error) }
      
      try {
        await dxdVotingMachine.contract.shareSignedVote(
          dxdVotingMachine.address, proposalId, 1, 71, votesignature, {from: accounts[2]}
        );
        assert(false, "cannot share invalid vote signature with higher REP");
      } catch(error) { helpers.assertVMException(error) }
      
      try {
        await dxdVotingMachine.contract.shareSignedVote(
          dxdVotingMachine.address, proposalId, 1, 70, votesignature, {from: accounts[1]}
        );
        assert(false, "cannot share invalid vote signature form other address");
      } catch(error) { helpers.assertVMException(error) }
      
    });
    
    it("fail executing vote with invalid data", async function() {
      const voteHash = await dxdVotingMachine.contract.hashVote(
        dxdVotingMachine.address, proposalId, accounts[2], 1, 70
      );
      const votesignature = fixSignature(await web3.eth.sign(voteHash, accounts[2]));  
      assert.equal(accounts[2], web3.eth.accounts.recover(voteHash, votesignature));
      
      const shareVoteTx = await dxdVotingMachine.contract.shareSignedVote(
        dxdVotingMachine.address, proposalId, 1, 70, votesignature, {from: accounts[2]}
      );
      const voteInfoFromLog = shareVoteTx.logs[0].args;
      
      try {
        await dxdVotingMachine.contract.executeSignedVote(
          voteInfoFromLog.votingMachine,
          voteInfoFromLog.proposalId,
          voteInfoFromLog.voter,
          2,
          voteInfoFromLog.amount,
          voteInfoFromLog.signature,
          {from: accounts[4]}
        );
        assert(false, "cannot execute vote signature with different vote");
      } catch(error) { helpers.assertVMException(error) }
      
      try {
        await dxdVotingMachine.contract.executeSignedVote(
          voteInfoFromLog.votingMachine,
          voteInfoFromLog.proposalId,
          voteInfoFromLog.voter,
          voteInfoFromLog.voteDecision,
          voteInfoFromLog.amount - 1,
          voteInfoFromLog.signature,
          {from: accounts[4]}
        );
        assert(false, "cannot execute vote signature with less REP");
      } catch(error) { helpers.assertVMException(error) }
      
      try {
        await dxdVotingMachine.contract.executeSignedVote(
          voteInfoFromLog.votingMachine,
          voteInfoFromLog.proposalId,
          accounts[1],
          voteInfoFromLog.voteDecision,
          voteInfoFromLog.amount,
          voteInfoFromLog.signature,
          {from: accounts[4]}
        );
        assert(false, "cannot execute vote signature form other address");
      } catch(error) { helpers.assertVMException(error) }
      
    });

    it("positive signed decision with all rep available", async function() {
      const voteHash = await dxdVotingMachine.contract.hashVote(
        dxdVotingMachine.address, proposalId, accounts[2], 1, 0
      );
      const votesignature = fixSignature(await web3.eth.sign(voteHash, accounts[2]));  
      assert.equal(accounts[2], web3.eth.accounts.recover(voteHash, votesignature));
      
      const shareVoteTx = await dxdVotingMachine.contract.shareSignedVote(
        dxdVotingMachine.address, proposalId, 1, 0, votesignature, { from: accounts[2] }
      );
      const voteInfoFromLog = shareVoteTx.logs[0].args;
      await dxdVotingMachine.contract.executeSignedVote(
        voteInfoFromLog.votingMachine,
        voteInfoFromLog.proposalId,
        voteInfoFromLog.voter,
        voteInfoFromLog.voteDecision,
        voteInfoFromLog.amount,
        voteInfoFromLog.signature,
        { from: accounts[4] }
      );
      
      await cheapVoteWalletScheme.execute(proposalId);
      const organizationProposal = await cheapVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.executed);
    });
    
    it("negative signed decision with less rep than the one held", async function() {
      // The voter has 70 rep but votes with 60 rep
      const voteHash = await dxdVotingMachine.contract.hashVote(
        dxdVotingMachine.address, proposalId, accounts[2], 2, 60
      );
      const votesignature = fixSignature(await web3.eth.sign(voteHash, accounts[2]));  
      assert.equal(accounts[2], web3.eth.accounts.recover(voteHash, votesignature));
      
      const shareVoteTx = await dxdVotingMachine.contract.shareSignedVote(
        dxdVotingMachine.address, proposalId, 2, 60, votesignature, { from: accounts[2] }
      );
      const voteInfoFromLog = shareVoteTx.logs[0].args;

      await dxdVotingMachine.contract.executeSignedVote(
        voteInfoFromLog.votingMachine,
        voteInfoFromLog.proposalId,
        voteInfoFromLog.voter,
        voteInfoFromLog.voteDecision,
        voteInfoFromLog.amount,
        voteInfoFromLog.signature,
        { from: accounts[4] }
      );
      
      const organizationProposal = await cheapVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.failed);
    });
  });
  
  describe('Signal Votes', function(){
    
    beforeEach( async function(){
      const wallet = await Wallet.new();
      await web3.eth.sendTransaction({
        from: accounts[0], to: org.avatar.address, value: TEST_VALUE
      });
      await wallet.transferOwnership(org.avatar.address);
    
      const genericCallDataTransfer = helpers.encodeGenericCallData(
        org.avatar.address, wallet.address, "0x0", TEST_VALUE
      );
    
      const tx = await cheapVoteWalletScheme.proposeCalls(
        [org.controller.address],
        [genericCallDataTransfer],
        [0],
        TEST_HASH
      );
      proposalId = await helpers.getValueFromLogs(tx, "_proposalId");
    })
    
    it("positive signal decision", async function() {
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).voteDecision, 0);
      const signalVoteTx = await dxdVotingMachine.contract.signalVote(
        proposalId, 1, 60, { from: accounts[2] }
      );
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).voteDecision, 1);
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).amount, 60);
      assert.equal(signalVoteTx.receipt.gasUsed, 66377);
      const voteInfoFromLog = signalVoteTx.logs[0].args;
      await dxdVotingMachine.contract.executeSignaledVote(
        voteInfoFromLog.proposalId,
        voteInfoFromLog.voter,
        voteInfoFromLog.voteDecision,
        voteInfoFromLog.amount,
        { from: accounts[4] }
      );
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).voteDecision, 0);
      await cheapVoteWalletScheme.execute(proposalId);
      const organizationProposal = await cheapVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.executed);
    });
    
    it("negative signal decision", async function() {
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).voteDecision, 0);
      const signalVoteTx = await dxdVotingMachine.contract.signalVote(
        proposalId, 2, 0, { from: accounts[2] }
      );
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).voteDecision, 2);
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).amount, 0);
      assert.equal(signalVoteTx.receipt.gasUsed, 47153);
      const voteInfoFromLog = signalVoteTx.logs[0].args;
      await dxdVotingMachine.contract.executeSignaledVote(
        voteInfoFromLog.proposalId,
        voteInfoFromLog.voter,
        voteInfoFromLog.voteDecision,
        voteInfoFromLog.amount,
        { from: accounts[4] }
      );
      assert.equal((await dxdVotingMachine.contract.votesSignaled(proposalId, accounts[2])).voteDecision, 0);
      const organizationProposal = await cheapVoteWalletScheme.getOrganizationProposal(proposalId);
      assert.equal(organizationProposal.state, ProposalState.failed);
    });
        
  });

});
