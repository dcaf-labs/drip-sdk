import { Program, AnchorProvider } from '@project-serum/anchor';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from '@solana/web3.js';
import { Configs } from '../config';
import { Drip } from '../idl/type';
import DripIDL from '../idl/idl.json';
import { DripAdmin } from '../interfaces';
import { InitVaultProtoConfigParams, InitVaultParams } from '../interfaces/drip-admin/params';
import { Network } from '../models';
import {
  InitVaultProtoConfigPreview,
  isInitVaultProtoConfigPreview,
} from '../interfaces/drip-admin/previews';
import { BroadcastTransactionWithMetadata, TransactionWithMetadata } from '../types';
import { BN } from 'bn.js';
import { ZERO } from '../constants';
import { toPubkey } from '../utils';
import { VaultAlreadyExistsError } from '../errors';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { findVaultPeriodPubkey, findVaultPubkey } from '../helpers';
import { makeExplorerUrl } from '../utils/transaction';

export class DripAdminImpl implements DripAdmin {
  private readonly vaultProgram: Program<Drip>;

  // For now we can do this, but we should transition to taking in a read-only connection here instead and
  // letting users only pass in signer at the end if they choose to else sign and broadcast the tx themselves
  // We should also decouple anchor from this to make it an actual SDK
  constructor(private readonly provider: AnchorProvider, private readonly network: Network) {
    const config = Configs[network];
    this.vaultProgram = new Program(DripIDL as unknown as Drip, config.vaultProgramId, provider);
  }

  public getInitVaultProtoConfigPreview(
    params: InitVaultProtoConfigParams
  ): InitVaultProtoConfigPreview {
    const vaultProtoConfigKeypair = Keypair.generate();

    return {
      ...params,
      vaultProtoConfigKeypair,
    };
  }

  public async getInitVaultProtoConfigTx(
    params: InitVaultProtoConfigParams | InitVaultProtoConfigPreview
  ): Promise<TransactionWithMetadata<{ vaultProtoConfigKeypair: Keypair }>> {
    const { granularity, tokenADripTriggerSpread, tokenBWithdrawalSpread } = params;
    const vaultProtoConfigKeypair = isInitVaultProtoConfigPreview(params)
      ? params.vaultProtoConfigKeypair
      : Keypair.generate();

    const tx = await this.vaultProgram.methods
      .initVaultProtoConfig({
        granularity: new BN(granularity.toString()),
        tokenADripTriggerSpread,
        tokenBWithdrawalSpread,
        admin: toPubkey(params.admin),
      })
      .accounts({
        vaultProtoConfig: vaultProtoConfigKeypair.publicKey,
        creator: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([vaultProtoConfigKeypair])
      .transaction();

    return {
      tx,
      metadata: {
        vaultProtoConfigKeypair,
      },
    };
  }

  public async initVaultProtoConfig(
    params: InitVaultProtoConfigParams | InitVaultProtoConfigPreview
  ): Promise<BroadcastTransactionWithMetadata<{ vaultProtoConfigKeypair: Keypair }>> {
    const { tx, metadata } = await this.getInitVaultProtoConfigTx(params);
    const txHash = await this.provider.sendAndConfirm(tx, [metadata.vaultProtoConfigKeypair]);

    return {
      id: txHash,
      explorer: makeExplorerUrl(txHash, this.network),
      metadata,
    };
  }

  public async getInitVaultTx(
    params: InitVaultParams
  ): Promise<TransactionWithMetadata<{ vaultPubkey: PublicKey }>> {
    const vaultPubkey = findVaultPubkey(this.vaultProgram.programId, params);
    const vaultAccount = await this.vaultProgram.account.vault.fetchNullable(vaultPubkey);

    if (vaultAccount) {
      throw new VaultAlreadyExistsError(vaultPubkey);
    }

    const vaultGenesisPeriodId = ZERO;
    const vaultGenesisPeriodPubkey = findVaultPeriodPubkey(this.vaultProgram.programId, {
      vault: vaultPubkey,
      periodId: vaultGenesisPeriodId,
    });

    const initVaultPeriodIxPromise = this.vaultProgram.methods
      .initVaultPeriod({
        periodId: vaultGenesisPeriodId,
      })
      .accounts({
        vaultPeriod: vaultGenesisPeriodPubkey,
        vault: vaultPubkey,
        tokenAMint: params.tokenAMint,
        tokenBMint: params.tokenBMint,
        vaultProtoConfig: params.protoConfig,
        creator: this.provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .instruction();

    const [tokenAAccount, tokenBAccount] = await Promise.all([
      getAssociatedTokenAddress(
        toPubkey(params.tokenAMint),
        vaultPubkey,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
      getAssociatedTokenAddress(
        toPubkey(params.tokenBMint),
        vaultPubkey,
        true,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID
      ),
    ]);

    const initVaultIx = await this.vaultProgram.methods
      .initVault({
        maxSlippageBps: params.maxSlippageBps,
        whitelistedSwaps: params.whitelistedSwaps.map(toPubkey),
      })
      .accounts({
        vault: vaultPubkey,
        vaultProtoConfig: params.protoConfig,
        tokenAAccount,
        tokenBAccount,
        treasuryTokenBAccount: params.tokenBFeeTreasury,
        tokenAMint: params.tokenAMint,
        tokenBMint: params.tokenBMint,
        creator: this.provider.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const initVaultPeriodIx = await initVaultPeriodIxPromise;

    const tx = new Transaction({
      recentBlockhash: (await this.provider.connection.getLatestBlockhash()).blockhash,
      feePayer: this.provider.wallet.publicKey,
    })
      .add(initVaultIx)
      .add(initVaultPeriodIx);

    return {
      tx,
      metadata: {
        vaultPubkey,
      },
    };
  }

  public async initVault(
    params: InitVaultParams
  ): Promise<BroadcastTransactionWithMetadata<{ vaultPubkey: PublicKey }>> {
    const { tx, metadata } = await this.getInitVaultTx(params);
    const txHash = await this.provider.sendAndConfirm(tx);

    return {
      id: txHash,
      explorer: makeExplorerUrl(txHash, this.network),
      metadata,
    };
  }
}