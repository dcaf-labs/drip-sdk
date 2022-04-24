import { PublicKey } from '@solana/web3.js';
import { Network } from '../models';
import * as devnet from './devnet';
import { Vault, VaultProtoConfig, Token } from './types';

export interface Config {
  vaultProgramId: PublicKey;
  tokens: Record<string, Token>;
  vaultProtoConfigs: Record<string, VaultProtoConfig>;
  vaults: Record<string, Vault>;
}

export const Configs: Record<Network, Config> = {
  [Network.Mainnet]: {
    vaultProgramId: PublicKey.default,
    tokens: {},
    vaultProtoConfigs: {},
    vaults: {},
  },
  [Network.Devnet]: devnet,
};

export * from './types';
