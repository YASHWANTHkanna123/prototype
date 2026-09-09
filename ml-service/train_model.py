"""
train_model.py
---------------
Trains a gradient boosting regressor to predict expected accumulated
delay (in minutes) at a given point along a train's route, using
features that generalize to trains NOT in the training set:

  - journey_progress    (0 = origin, 1 = destination)
  - train_category      (superfast / express / passenger / other, from
                          the train number series)
  - station_delay_index (this station's typical delay contribution,
                          learned from OTHER trains that pass through
                          it -- a real railway signal: some junctions
                          and sections are just more congested than
                          others, regardless of which train it is)

train_number itself and the pct_* columns are deliberately excluded:
train_number doesn't generalize to unseen trains, and the pct_*
columns are just another view of the same historical distribution as
the label (using them would be leakage, not prediction).

Evaluation uses GroupKFold on train_number so that no station from a
given train appears in both the training and test fold for that split
-- this measures how well the model generalizes to an unseen train,
which is the real use case for this app's 3 mock trains that have no
scraped history at all. station_delay_index is computed *inside* each
fold from the training trains only, so a held-out train's own data
never leaks into its own station encoding.
"""

import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import GradientBoostingRegressor
from sklearn.model_selection import GroupKFold
from sklearn.metrics import mean_absolute_error
from sklearn.preprocessing import OneHotEncoder
from sklearn.compose import ColumnTransformer
from sklearn.pipeline import Pipeline

FEATURES_PATH = "features.csv"
MODEL_PATH = "delay_model.joblib"

NUMERIC_FEATURES = ["journey_progress", "station_delay_index"]
CATEGORICAL_FEATURES = ["train_category"]


def station_delay_index_table(df: pd.DataFrame) -> pd.Series:
    """
    Mean historical delay at each station, averaged across every train
    that passes through it. This is a station/section congestion
    signal, independent of any single train -- so it carries real
    information about a train we've never seen before, as long as its
    route overlaps known junctions (which almost every Indian Railways
    route does).
    """
    return df.groupby("station_code")["average_delay_minutes"].mean()


def apply_station_index(df: pd.DataFrame, index_table: pd.Series, global_mean: float) -> pd.Series:
    return df["station_code"].map(index_table).fillna(global_mean)


def build_pipeline() -> Pipeline:
    preprocessor = ColumnTransformer(
        transformers=[
            ("cat", OneHotEncoder(handle_unknown="ignore"), CATEGORICAL_FEATURES),
        ],
        remainder="passthrough",  # numeric features pass through unchanged
    )
    model = GradientBoostingRegressor(
        n_estimators=200,
        max_depth=3,
        learning_rate=0.05,
        subsample=0.8,
        random_state=42,
    )
    return Pipeline([("preprocess", preprocessor), ("model", model)])


def evaluate_grouped(df: pd.DataFrame, n_splits: int = 5):
    """Group-aware CV: whole trains are held out, not individual rows."""
    y = df["average_delay_minutes"].values
    groups = df["train_number"].values

    gkf = GroupKFold(n_splits=n_splits)
    fold_maes = []
    naive_maes = []

    for fold, (train_idx, test_idx) in enumerate(gkf.split(df, y, groups), start=1):
        train_df = df.iloc[train_idx].copy()
        test_df = df.iloc[test_idx].copy()

        # Station index built ONLY from this fold's training trains.
        index_table = station_delay_index_table(train_df)
        global_mean = train_df["average_delay_minutes"].mean()
        train_df["station_delay_index"] = apply_station_index(train_df, index_table, global_mean)
        test_df["station_delay_index"] = apply_station_index(test_df, index_table, global_mean)

        X_train = train_df[NUMERIC_FEATURES + CATEGORICAL_FEATURES]
        X_test = test_df[NUMERIC_FEATURES + CATEGORICAL_FEATURES]

        pipe = build_pipeline()
        pipe.fit(X_train, y[train_idx])
        preds = pipe.predict(X_test)
        mae = mean_absolute_error(y[test_idx], preds)
        fold_maes.append(mae)

        # Naive baseline: always predict the training set's mean delay.
        naive_pred = np.full_like(y[test_idx], fill_value=y[train_idx].mean(), dtype=float)
        naive_mae = mean_absolute_error(y[test_idx], naive_pred)
        naive_maes.append(naive_mae)

        print(f"Fold {fold}: model MAE = {mae:.2f} min | naive-mean MAE = {naive_mae:.2f} min")

    print(f"\nAverage model MAE across folds: {np.mean(fold_maes):.2f} min")
    print(f"Average naive-mean MAE across folds: {np.mean(naive_maes):.2f} min")
    improvement = 100 * (1 - np.mean(fold_maes) / np.mean(naive_maes))
    print(f"Improvement over naive baseline: {improvement:.1f}%")

    return fold_maes, naive_maes


def compute_residual_std(df: pd.DataFrame, pipe: Pipeline) -> float:
    """Used later to build a rough +/- confidence range around a point
    prediction, since GradientBoostingRegressor doesn't give one natively."""
    X = df[NUMERIC_FEATURES + CATEGORICAL_FEATURES]
    y = df["average_delay_minutes"].values
    preds = pipe.predict(X)
    residuals = y - preds
    return float(np.std(residuals))


if __name__ == "__main__":
    df = pd.read_csv(FEATURES_PATH)

    print("=== Grouped cross-validation (held-out trains) ===")
    evaluate_grouped(df)

    print("\n=== Training final model on all data ===")
    final_index_table = station_delay_index_table(df)
    final_global_mean = df["average_delay_minutes"].mean()
    df["station_delay_index"] = apply_station_index(df, final_index_table, final_global_mean)

    final_pipe = build_pipeline()
    X = df[NUMERIC_FEATURES + CATEGORICAL_FEATURES]
    y = df["average_delay_minutes"].values
    final_pipe.fit(X, y)

    residual_std = compute_residual_std(df, final_pipe)
    print(f"Residual std (used for confidence range): {residual_std:.2f} min")

    # Quantile models give a genuine prediction interval (10th/90th
    # percentile) instead of a flat +/- std band, so the "expected
    # range" and confidence shown in the UI reflect actual uncertainty
    # at that journey stage rather than one fixed number for every
    # prediction.
    print("Training quantile models for prediction interval (p10 / p90)...")
    lower_pipe = build_pipeline()
    lower_pipe.set_params(model__loss="quantile", model__alpha=0.1)
    lower_pipe.fit(X, y)

    upper_pipe = build_pipeline()
    upper_pipe.set_params(model__loss="quantile", model__alpha=0.9)
    upper_pipe.fit(X, y)

    joblib.dump(
        {
            "pipeline": final_pipe,
            "lower_pipeline": lower_pipe,
            "upper_pipeline": upper_pipe,
            "residual_std": residual_std,
            "station_index_table": final_index_table,
            "global_mean_delay": final_global_mean,
            "numeric_features": NUMERIC_FEATURES,
            "categorical_features": CATEGORICAL_FEATURES,
        },
        MODEL_PATH,
    )
    print(f"Saved model to {MODEL_PATH}")

