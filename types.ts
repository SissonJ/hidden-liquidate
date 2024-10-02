export type VaultResponse = {
  vault: {
    open_positions: {
      value:string,
    },
    position_id_counter: {
      value: string,
    }
  }
}

export type Results = {
  contracts: {
    address: string,
    code_hash: string,
    vault_ids: number[],
    vaults_to_skip: number[],
  }[],
  results: {
      [vault: string]: {
        lastUpdated: number,
        checkedUpTo: number,
        liquidatedMetrics: number[],
        liquidated: number[],
        solvent: number[],
        skipped: number[],
    }
  }
}
