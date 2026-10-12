import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { Me } from './types';

export const MeContext = createContext<Me | null>(null);

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside signed-in app');
  return me;
}
