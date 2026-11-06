import { countTokens as countO200k } from 'gpt-tokenizer/encoding/o200k_base';

export function countTokens(text: string): number {
  return countO200k(text);
}
