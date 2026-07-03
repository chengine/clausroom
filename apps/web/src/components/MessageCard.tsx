import { useState, type CSSProperties } from 'react';
import type { Artifact, Message } from '@clausroom/protocol';
import { fmtTime, humanSize, initials, isArtifactDead, preview, shortSha, typeLabel } from '../format.js';
import { BotIcon, CheckIcon, DownloadIcon, FileIcon, PersonIcon, ReplyIcon, SparkIcon } from './icons.js';
import { Markdown } from './Markdown.js';

interface MessageCardProps {
  message: Message;
  color: string;
  /**
   * True when the sender belongs to the viewer's camp (the viewer or an agent
   * they own): the card aligns right with mirrored chrome. system_event rows
   * ignore this and stay centered.
   */
  mine: boolean;
  nameOf: (userId: string) => string;
  messageById: (id: string) => Message | undefined;
  artifactById: (id: string) => Artifact | undefined;
  onDownloadArtifact: (artifact: Artifact) => void;
  /** Decision cards: the choice a human already answered with (null = open). */
  answeredChoice: string | null;
  /** Whether the viewer may click a choice (human participant with can_send). */
  canChoose: boolean;
  /** Posts the choice text as a human reply to this card. Never rejects. */
  onChoose: (choice: string) => Promise<void>;
  /** Live agent-activity: the sender is currently reporting 'working'. */
  senderWorking: boolean;
}

export function MessageCard({
  message,
  color,
  mine,
  nameOf,
  messageById,
  artifactById,
  onDownloadArtifact,
  answeredChoice,
  canChoose,
  onChoose,
  senderWorking,
}: MessageCardProps) {
  // The choice currently being posted; all buttons disable while in flight.
  const [pendingChoice, setPendingChoice] = useState<string | null>(null);

  async function choose(choice: string) {
    if (pendingChoice !== null || answeredChoice !== null || !canChoose) return;
    setPendingChoice(choice);
    try {
      await onChoose(choice);
    } finally {
      setPendingChoice(null);
    }
  }

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
      className={`msg-card ${mine ? 'msg-card--mine' : 'msg-card--theirs'}`}
      data-message-id={message.id}
      style={{ '--pc': color } as CSSProperties}
    >
      <div className="msg-card__avatar" aria-hidden="true">
        {initials(message.sender.display_name)}
        {senderWorking && (
          <span className="presence-dot presence-dot--on presence-dot--working" title="working…" />
        )}
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

        {message.choices && message.choices.length > 0 && (
          <div className="choice-row" role="group" aria-label="Decision choices">
            {message.choices.map((choice, i) => {
              const chosen = answeredChoice === choice;
              return (
                <button
                  key={`${i}:${choice}`}
                  type="button"
                  className={`choice-pill${chosen ? ' choice-pill--chosen' : ''}`}
                  disabled={answeredChoice !== null || pendingChoice !== null || !canChoose}
                  onClick={() => void choose(choice)}
                >
                  {chosen && <CheckIcon size={12} />}
                  <span className="choice-pill__text">{choice}</span>
                  {pendingChoice === choice && <span className="choice-pill__spinner" />}
                </button>
              );
            })}
          </div>
        )}

        {message.artifact_ids.length > 0 && (
          <div className="msg-card__artifacts">
            {message.artifact_ids.map((id) => {
              const artifact = artifactById(id);
              if (!artifact) {
                return (
                  <span key={id} className="artifact-chip artifact-chip--loading">
                    <FileIcon size={14} />
                    <span className="artifact-chip__name">loading artifact…</span>
                  </span>
                );
              }
              const dead = isArtifactDead(artifact);
              return (
                <button
                  key={id}
                  type="button"
                  className={`artifact-chip${dead ? ' artifact-chip--dead' : ''}`}
                  onClick={() => onDownloadArtifact(artifact)}
                  title={dead ? 'expired or deleted' : `sha256 ${artifact.sha256}`}
                >
                  <FileIcon size={14} />
                  <span className="artifact-chip__name">{artifact.filename}</span>
                  <span className="artifact-chip__meta">
                    {humanSize(artifact.size_bytes)} · {dead ? 'expired' : shortSha(artifact.sha256)}
                  </span>
                  {!dead && <DownloadIcon size={13} className="artifact-chip__dl" />}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </article>
  );
}
