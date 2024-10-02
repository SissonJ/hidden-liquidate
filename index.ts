import * as fs from 'fs';
import { MsgExecuteContract, SecretNetworkClient, TxResponse, Wallet } from 'secretjs';
import {Results, VaultResponse} from './types';
import { config } from 'dotenv';

config();

const client = new SecretNetworkClient({
  url: process.env.LCD_URL_0!,
  chainId: 'secret-4',
  wallet: new Wallet(process.env.MNEMONIC!),
  walletAddress: "secret1wuz2jpqzrtcerjqa5rtc3u5f4kahtfd0yt0pta",
  encryptionSeed: new Uint8Array(32),
});

// wETH 8
// wstETH 11
//const VAULT_ID = "1"; //"4"; //"12"; //"5";
//const ADDRESS = "secret1qxk2scacpgj2mmm0af60674afl9e6qneg7yuny";
//const CODE_HASH = "ac5d501827d9a337a618ca493fcbf1323b20771378774a6bf466cb66361bf021";

const resultsUnparsed = fs.readFileSync('./results.txt', 'utf-8');

async function withLogging() {
  let results: Results = JSON.parse(resultsUnparsed);

  for(let j = 0; j < results.contracts.length; j++) {
    const contract = results.contracts[j];
    for(let k = 0; k < contract.vault_ids.length; k++) {
      let vaultId = contract.vault_ids[k];
      console.log("STARTING CONTRACT ", contract.address, " VAULT: ", vaultId);
      const response = await client.query.compute.queryContract({
        contract_address: contract.address,
        code_hash: contract.code_hash,
        query: {
          vault: {
            vault_id: String(vaultId),
          }
        }
      }) as VaultResponse;

      let vaultResults = results.results[`${contract.address}${vaultId}`];
      if(!vaultResults) {
        results.results[`${contract.address}${vaultId}`] = {
          lastUpdated: 0,
          checkedUpTo: 0,
          liquidatedMetrics: [],
          liquidated: [],
          solvent: [],
          skipped: [],
        }
        vaultResults = {
          lastUpdated: 0,
          checkedUpTo: 0,
          liquidatedMetrics: [],
          liquidated: [],
          solvent: [],
          skipped: [],
        }
      }

      if( new Date().getTime() - vaultResults.lastUpdated < 86400000) {
        console.log('HAS BEEN RAN WITHIN 24 HOURS, SKIPPING: ', vaultId);
        continue;
      }

      if(contract.vaults_to_skip.includes(vaultId)) {
        console.log('DESIGNATED TO SKIP, SKIPPING: ', vaultId);
        continue;
      }

      let liquidatablePositions: number[] = [
        ...vaultResults.liquidated,
        ...vaultResults.solvent,
        ...vaultResults.skipped,
      ];

      for(let i = vaultResults.checkedUpTo; i < Number(response.vault.position_id_counter.value); i++) {
        liquidatablePositions.push(i);
      }
      liquidatablePositions = [...new Set(liquidatablePositions)];
      console.log(JSON.stringify(liquidatablePositions));

      let newLiquidated = [];
      let newSolvent = [];
      let newSkipped = [];

      let retry = 0;
      let txHash;

      for(let i = 0; i < liquidatablePositions.length; i ++) {
        const positionId = liquidatablePositions[i];
        console.log("\n", positionId, retry);
        try {
          if(retry === 0) {
            txHash = undefined;
          }
          await new Promise((resolve) => setTimeout(resolve, 5000));
          let executeResponse: TxResponse | null = null; 
          if(txHash) {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            executeResponse = await client.query.getTx(txHash);
          } else {
            executeResponse = await client.tx.broadcast([new MsgExecuteContract({ 
                sender: client.address, 
                contract_address: contract.address, 
                msg: { liquidate: { vault_id: String(vaultId), position_id: String(positionId) } }, 
                sent_funds: [],
                code_hash:contract.code_hash 
              })],
              {
                gasLimit: 500000,
                feeDenom: "uscrt",
              },
            )
          }
          if(executeResponse === null) {
            throw new Error(`Transaction not found ${txHash}`);
          }
          if(executeResponse.code === 0) {
            console.log('LIQUIDATION ATTEMPT CODE 0');
            console.log(executeResponse.transactionHash);
            if(!executeResponse.arrayLog && !executeResponse.jsonLog) {
              txHash = executeResponse.transactionHash;
              throw new Error("Missing log - liquidate");
            }
            console.log(JSON.stringify(executeResponse.arrayLog));
            console.log(JSON.stringify(executeResponse.jsonLog));
            newLiquidated.push(positionId);
          } else {
            if(executeResponse.rawLog === undefined || executeResponse.rawLog.length === 0) {
              console.log('NO LOG');
              txHash = executeResponse.transactionHash;
              throw new Error("Missing log");
            }
            console.log(executeResponse.rawLog);
          }
          if(executeResponse.rawLog?.includes("solvent")) {
            newSolvent.push(positionId);
          }
          if(executeResponse.rawLog?.includes("incorrect account sequence")) {
            await new Promise((resolve) => setTimeout(resolve, 10000));
            throw new Error("account sequence");
          }
          if(executeResponse.rawLog?.includes("out of gas")){
            console.log('LIQUIDATION ATTEMPT OOG');
            await new Promise((resolve) => setTimeout(resolve, 500));
            const liquidate = await client.tx.broadcast([new MsgExecuteContract({ 
                sender: client.address, 
                contract_address: contract.address, 
                msg: { liquidate: { vault_id: String(vaultId), position_id: String(positionId) } }, 
                sent_funds: [],
                code_hash: contract.code_hash,
              })],
              {
                gasLimit: 1500000,
                feeDenom: "uscrt",
              }
            );
            console.log(liquidate.transactionHash);
            if(liquidate?.arrayLog || liquidate?.jsonLog) {
              console.log(JSON.stringify(liquidate.arrayLog));
              console.log(JSON.stringify(liquidate.jsonLog));
              newLiquidated.push(positionId);
            }
            else {
              txHash = liquidate.transactionHash;
              throw new Error(liquidate.rawLog);
            }
          }
          retry = 0;
        } catch(error: any) {
          if(retry > 3) {
            console.log('SKIPPING: ', positionId);
            newSkipped.push(positionId);
            retry = 0;
          } else {
            retry += 1;
            i -= 1;
            console.log(error?.message);
          }
        }
      };
      console.log("liquidated: ", JSON.stringify(newLiquidated), "solvent: ", JSON.stringify(newSolvent), "skipped: ", JSON.stringify(newSkipped));
      const newResults = {
        lastUpdated: new Date().getTime(),
        checkedUpTo: Number(response.vault.position_id_counter.value),
        liquidatedMetrics: results.results[`${contract.address}${vaultId}`].liquidatedMetrics.concat(newLiquidated),
        liquidated: newLiquidated,
        solvent: newSolvent,
        skipped: newSkipped,
      };
      results.results[`${contract.address}${vaultId}`] = newResults;
      fs.writeFileSync('./results.txt', JSON.stringify(results));
    }
  }
}

withLogging().then(() => { console.log('Finished!') });

/*async function main() {

  const response = await client.query.compute.queryContract({
    contract_address: ADDRESS,
    code_hash: CODE_HASH,
    query: {
      vault: {
        vault_id: VAULT_ID,
      }
    }
  }) as VaultResponse;
  console.log(response.vault.position_id_counter.value);

  let retry = 0;

  for (let i = 0; i < Number(response.vault.position_id_counter.value); i++) {
    console.log("\n", i, retry);
    try {
      const executeResponse = await client.tx.broadcast([new MsgExecuteContract({ 
          sender: client.address, 
          contract_address: ADDRESS, 
          msg: { liquidate: { vault_id: VAULT_ID, position_id: String(i) } }, 
          sent_funds: [],
          code_hash: CODE_HASH
        })],
        {
          gasLimit: 500000,
          feeDenom: "uscrt",
        }
      );
      console.log(executeResponse.rawLog);
      if(executeResponse.rawLog.includes("incorrect account sequence")) {
        await new Promise((resolve) => setTimeout(resolve, 10000));
        throw new Error("account sequence");
      }
      if(executeResponse.rawLog.includes("out of gas")){
        const liquidate = await client.tx.broadcast([new MsgExecuteContract({ 
            sender: client.address, 
            contract_address: ADDRESS, 
            msg: { liquidate: { vault_id: VAULT_ID, position_id: String(i) } }, 
            sent_funds: [],
            code_hash: CODE_HASH
          })],
          {
            gasLimit: 1500000,
            feeDenom: "uscrt",
          }
        );
        console.log('LIQUIDATION ATTEMPT');
        if(liquidate.arrayLog) {
         console.log(JSON.stringify(liquidate.arrayLog));
        }
        else {
          throw new Error(liquidate.rawLog);
        }
      }
      retry = 0;
    } catch(error) {
      if(retry > 3) {
        console.log('SKIPPING: ', i);
        retry = 0;
      } else {
        retry += 1;
        i -= 1;
        console.log(error);
      }
    }
  }
}

main().then(() => { console.log('Finished!') });*/
