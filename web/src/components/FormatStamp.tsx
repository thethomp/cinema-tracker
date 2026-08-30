import { isStamped, tagLabel } from '../entry'

export interface FormatStampProps {
  tag: string
}

/**
 * A rubber stamp on paper: vermilion outline, no fill, set very slightly off
 * square.
 *
 * The guard is the component's reason to exist. Vermilion is the page's only
 * loud colour and it means one thing -- a print or a performance you cannot
 * get on another night. Handed anything else, this renders nothing at all
 * rather than quietly widening what the accent stands for.
 */
export function FormatStamp({ tag }: FormatStampProps) {
  if (!isStamped(tag)) return null
  return <span className="stamp">{tagLabel(tag)}</span>
}
