'use client';

import { ConnectModal, useCurrentAccount, useDisconnectWallet } from '@mysten/dapp-kit';
import { normalizeSuiAddress } from '@mysten/sui/utils';
import { useState } from 'react';
import { shortAddress } from './format.js';
import { useOverview } from './session.js';
import { Button, ErrorLine } from './ui.js';

export type OwnerWallet = { kind: 'ready' } | { kind: 'none' } | { kind: 'wrong'; owner: string };

/**
 * Whether the connected wallet can sign for this owner. The session outlasts the wallet link, and a
 * wallet can switch account, so a signature is only asked for when the account is the one that signed in.
 */
export function useOwnerWallet(): OwnerWallet {
  const account = useCurrentAccount();
  const { data } = useOverview();
  const owner = data?.owner.suiAddress;
  if (!account) return { kind: 'none' };
  if (owner !== undefined && normalizeSuiAddress(account.address) !== normalizeSuiAddress(owner)) {
    return { kind: 'wrong', owner };
  }
  return { kind: 'ready' };
}

/** Stands in for a sign button until the right wallet is connected. Changing wallets drops the current link first. */
export function ConnectWalletButton({ wallet }: { wallet: OwnerWallet }) {
  const [open, setOpen] = useState(false);
  const { mutate: disconnect } = useDisconnectWallet();
  return (
    <ConnectModal
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button
          variant="primary"
          size="lg"
          className="min-w-[160px] flex-1"
          onClick={wallet.kind === 'wrong' ? () => disconnect() : undefined}
        >
          Connect wallet
        </Button>
      }
    />
  );
}

export function WrongWalletNote({ wallet }: { wallet: OwnerWallet }) {
  if (wallet.kind !== 'wrong') return null;
  return (
    <ErrorLine>
      This wallet is not the one you signed in with. Switch to {shortAddress(wallet.owner)} in your wallet.
    </ErrorLine>
  );
}
