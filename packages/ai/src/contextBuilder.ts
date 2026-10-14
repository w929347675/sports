export type RecommendationImage = {
  id: number;
  mealId: number;
  createdAt: string;
  fileSize: number;
  base64: string;
  isConfirmed: boolean;
  riskRelated: boolean;
};

export type RecommendationContextInput = {
  profile: unknown;
  trends: unknown;
  structuredData: unknown;
  training: unknown;
  feedback: unknown;
  status: unknown;
  confirmedFood: unknown;
  estimatedFood: unknown;
  images: RecommendationImage[];
  explicitReview?: boolean;
  specifiedMealIds?: number[];
  maxBytes?: number;
};

export type RecommendationContext = {
  priority: string[];
  sections: {
    profile: unknown;
    trends: unknown;
    structuredData: unknown;
    training: unknown;
    feedback: unknown;
    status: unknown;
    confirmedFood: unknown;
    estimatedFood: unknown;
  };
  images: RecommendationImage[];
};

const contextPriority = [
  'profile',
  'trends',
  'structuredData',
  'training',
  'feedback',
  'status',
  'confirmedFood',
  'estimatedFood',
];

export function selectRecommendationImages({
  images,
  explicitReview = false,
  specifiedMealIds = [],
  maxBytes = 20 * 1024 * 1024,
}: {
  images: RecommendationImage[];
  explicitReview?: boolean;
  specifiedMealIds?: number[];
  maxBytes?: number;
}): RecommendationImage[] {
  if (!explicitReview) return [];

  const specified = new Set(specifiedMealIds);
  const ordered = images
    .map((image, index) => ({ image, index }))
    .sort((left, right) => {
      const leftPriority = specified.has(left.image.mealId)
        ? 0
        : !left.image.isConfirmed
          ? 1
          : left.image.riskRelated
            ? 2
            : 3;
      const rightPriority = specified.has(right.image.mealId)
        ? 0
        : !right.image.isConfirmed
          ? 1
          : right.image.riskRelated
            ? 2
            : 3;
      if (leftPriority !== rightPriority) return leftPriority - rightPriority;
      const timeDifference = Date.parse(right.image.createdAt) - Date.parse(left.image.createdAt);
      if (timeDifference !== 0) return timeDifference;
      return left.index - right.index;
    })
    .slice(0, 5)
    .map(({ image }) => image);

  const totalBytes = ordered.reduce((total, image) => total + image.fileSize, 0);
  if (totalBytes > maxBytes) {
    throw new Error('Selected recommendation images exceed the byte limit');
  }
  return ordered;
}

export function buildRecommendationContext(input: RecommendationContextInput): RecommendationContext {
  return {
    priority: [...contextPriority],
    sections: {
      profile: input.profile,
      trends: input.trends,
      structuredData: input.structuredData,
      training: input.training,
      feedback: input.feedback,
      status: input.status,
      confirmedFood: input.confirmedFood,
      estimatedFood: input.estimatedFood,
    },
    images: selectRecommendationImages(input),
  };
}
