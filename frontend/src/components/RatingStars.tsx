interface Props {
  rating: number;
  onChange?: (rating: number) => void;
}

export function RatingStars({ rating, onChange }: Props) {
  return (
    <span className="rating-stars">
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
          {n <= rating ? "★" : "☆"}
        </button>
      ))}
    </span>
  );
}
