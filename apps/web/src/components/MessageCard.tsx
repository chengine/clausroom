import type { CSSProperties } from 'react';
import type { Artifact, Message } from '@clausroom/protocol';
import { fmtTime, humanSize, initials, preview, shortSha, typeLabel } from '../format.js';
import { BotIcon, DownloadIcon, FileIcon, PersonIcon, ReplyIcon, SparkIcon } from './icons.js';
import { Markdown } from './Markdown.js';

interface MessageCardProps {
  message: Message;
  color: string;
  nameOf: (userId: string) => string;
  messageById: (id: string) => Message | undefined;
  artifactById: (id: string) => Artifact | undefined;
  onDownloadArtifact: (artifact: Artifact) => void;
}

export function MessageCard({
  message,
  color,
  nameOf,
  messageById,
  artifactById,
  onDownloadArtifact,
}: MessageCardProps) {
  if (message.message_type === 'system_event') {
    return (
      <div className="system-row" data-message-id={message.id}>
        <span className="system-row__icon">
          <SparkIcon size={12} />
        </span>
        <span className="system-row__text">{message.body_markdown}</span>
        <time className="system-row__time" dateTime={message.created_at} title={message.created_at}>
          {fmtTime(message.created_at)}
        </time>
      </div>
    );
  }

  const replyTo = message.reply_to_message_id ? messageById(message.reply_to_message_id) : undefined;
  const isAgent = message.sender.kind === 'agent';

  return (
    <article
      className="msg-card"
      data-message-id={message.id}
      style={{ '--pc': color } as CSSProperties}
    >
      <div className="msg-card__avatar" aria-hidden="true">
        {initials(message.sender.display_name)}
      </div>
      <div className="msg-card__main">
        <header className="msg-card__head">
          <span className="msg-card__sender">
            <span className="msg-card__kind" title={message.sender.kind}>
              {isAgent ? <BotIcon size={14} /> : <PersonIcon size={14} />}
            </span>
            {message.sender.display_name}
          </span>
          <span className={`type-badge type-badge--${message.message_type}`}>
            {typeLabel(message.message_type)}
          </span>
          {message.confidence && (
            <span className={`confidence-chip confidence-chip--${message.confidence}`}>
              {message.confidence} confidence
            </span>
          )}
          <time className="msg-card__time" dateTime={message.created_at} title={message.created_at}>
            {fmtTime(message.created_at)}
          </time>
        </header>

        {message.recipient_ids.length > 0 && (
          <div className="msg-card__recipients">
            to: {message.recipient_ids.map((id) => nameOf(id)).join(', ')}
          </div>
        )}

        {replyTo ? (
          <div className="msg-card__reply">
            <ReplyIcon size={12} />
            <span className="msg-card__reply-sender">{replyTo.sender.display_name}:</span>
            <span className="msg-card__reply-body">{preview(replyTo.body_markdown)}</span>
          </div>
        ) : (
          message.reply_to_message_id && (
            <div className="msg-card__reply">
              <ReplyIcon size={12} />
              <span className="msg-card__reply-body">replying to an earlier message</span>
            </div>
          )
        )}

        <Markdown source={message.body_markdown} />

        {message.artifact_ids.length > 0 && (
          <div className="msg-card__artifacts">
            {message.artifact_ids.map((id) => {
              const artifact = artifactById(id);
              return artifact ? (
                <button
                  key={id}
                  type="button"
                  className="artifact-chip"
                  onClick={() => onDownloadArtifact(artifact)}
                  title={`sha256 ${artifact.sha256}`}
                >
                  <FileIcon size={14} />
                  <span className="artifact-chip__name">{artifact.filename}</span>
                  <span className="artifact-chip__meta">
                    {humanSize(artifact.size_bytes)} · {shortSha(artifact.sha256)}
                  </span>
                  <DownloadIcon size={13} className="artifact-chip__dl" />
                </button>
              ) : (
                <span key={id} className="artifact-chip artifact-chip--loading">
                  <FileIcon size={14} />
                  <span className="artifact-chip__name">loading artifact…</span>
                </span>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}
