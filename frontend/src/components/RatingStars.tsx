import { IconStar } from "./Icons";

interface Props {
  rating: number;
  onChange?: (rating: number) => void;
  title?: string;
}

export function RatingStars({ rating, onChange, title }: Props) {
  return (
    <span className="rating-stars" title={title}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= rating ? "filled" : ""}
          disabled={!onChange}
          onClick={(e) => {
            e.stopPropagation();
            onChange?.(n === rating ? 0 : n);
          }}
          aria-label={`${n} star`}
        >
          <IconStar size={15} filled={n <= rating} />
        </button>
      ))}
    </span>
  );
}
