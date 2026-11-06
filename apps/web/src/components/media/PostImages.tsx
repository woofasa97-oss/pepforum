import type { PostImage } from '@pepforum/database';

/** Images attached to a post (…023), served from this origin via /media/<id>. */
export function PostImages({ images, caption }: { images: readonly PostImage[]; caption: string }) {
  if (images.length === 0) return null;
  return (
    <figure className="post-images" aria-label={caption}>
      {images.map((image) => (
        <a key={image.id} href={`/media/${image.id}`} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element -- member upload with known dimensions, same origin */}
          <img src={`/media/${image.id}`} alt={image.alt} width={image.width ?? undefined} height={image.height ?? undefined} loading="lazy" />
        </a>
      ))}
    </figure>
  );
}
