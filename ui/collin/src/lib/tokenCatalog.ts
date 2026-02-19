export type TokenKey = 'TNK' | 'BTC' | 'ETH' | 'SOL';

export type TokenDef = {
  key: TokenKey;
  name: string;
  symbol: string;
  coingeckoId: string;
  isTracTask?: boolean;
};

export const TOKENS: TokenDef[] = [
  {
    key: 'TNK',
    name: 'Trac Network',
    symbol: 'TNK',
    coingeckoId: 'trac-network',
    isTracTask: true
  },
  {
    key: 'BTC',
    name: 'Bitcoin',
    symbol: 'BTC',
    coingeckoId: 'bitcoin'
  },
  {
    key: 'ETH',
    name: 'Ethereum',
    symbol: 'ETH',
    coingeckoId: 'ethereum'
  },
  {
    key: 'SOL',
    name: 'Solana',
    symbol: 'SOL',
    coingeckoId: 'solana'
  }
];

export function tokenByKey(key: TokenKey): TokenDef {
  const t = TOKENS.find(x => x.key === key);
  if (!t) return TOKENS[0];
  return t;
}
