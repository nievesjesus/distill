import { S } from '../strings';

interface PreviewProps {
  id: string;
  name: string;
  text: string;
  detailed: boolean;
}

export function Preview({ id, name, text, detailed }: PreviewProps) {
  return (
    <div className="preview" data-detailed={detailed}>
      <div id={id} className="preview-text" role="region" tabIndex={0} aria-label={S.previewLabel(name)}>
        <pre>{text}</pre>
      </div>
    </div>
  );
}
