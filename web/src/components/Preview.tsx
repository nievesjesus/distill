import { S } from '../strings';

interface PreviewProps {
  id: string;
  name: string;
  text: string;
  detailed: boolean;
}

export function Preview({ id, name, text, detailed }: PreviewProps) {
  return (
    <div className="preview" data-detailed={detailed} aria-live="off">
      <pre id={id} className="preview-text" tabIndex={0} aria-label={S.previewLabel(name)}>
        {text}
      </pre>
    </div>
  );
}
