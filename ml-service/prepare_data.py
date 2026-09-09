"""
prepare_data.py
----------------
Loads the raw etrain.info-scraped historical delay dataset and turns it
into a clean, feature-engineered table suitable for training a delay
regression model.

Dataset shape: one row per (train_number, station_code) with the
*historical average* delay in minutes at that station, plus the
percentage of runs that were on-time / slightly delayed / significantly
delayed / cancelled. Rows for a given train appear in actual route
order (verified: delay accumulates with distance travelled).

Because this is aggregated historical data (not per-journey), the
learnable signal is: "how does expected delay grow as a train
progresses along its route, and does that growth pattern differ by
train category (superfast / express / passenger, inferred from the
train number series)?" That generalizes to trains outside the dataset,
which is what we need for the app's mock trains that were never
scraped (12635, 12627, 12650).
"""

import pandas as pd
import numpy as np

RAW_PATH = "etrain_delays.csv"
OUT_PATH = "features.csv"


def infer_train_category(train_number: int) -> str:
    """
    Very rough categorisation from Indian Railways numbering series.
    This is a heuristic, not an official mapping -- good enough to give
    the model a coarse "type of train" signal without needing an
    external lookup table.
    """
    n = train_number
    if 12000 <= n <= 12999:
        return "superfast"
    if 13000 <= n <= 19999:
        return "express"
    if 50000 <= n <= 59999:
        return "passenger"
    if 20000 <= n <= 20999:
        return "vande_bharat_or_premium"
    return "other"


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # Station order within each train's route, purely by file order
    # (verified to already be true geographic route order).
    df["station_order"] = df.groupby("train_number").cumcount()
    stops_per_train = df.groupby("train_number")["station_order"].transform("max")
    # journey_progress: 0 at origin, 1 at terminal station.
    # Guard against single-stop trains (division by zero).
    df["journey_progress"] = np.where(
        stops_per_train > 0, df["station_order"] / stops_per_train, 0.0
    )

    df["train_category"] = df["train_number"].apply(infer_train_category)

    # Drop rows with no target (terminal/origin stations where the
    # source doesn't report an average delay).
    df = df.dropna(subset=["average_delay_minutes"])

    # Drop obviously unreliable rows: a station with >50% "cancelled or
    # unknown" runs doesn't have a trustworthy average delay figure.
    df = df[df["pct_cancelled_unknown"] < 50]

    feature_cols = [
        "train_number",
        "train_name",
        "station_code",
        "station_name",
        "station_order",
        "journey_progress",
        "train_category",
        "average_delay_minutes",
    ]
    return df[feature_cols].reset_index(drop=True)


if __name__ == "__main__":
    raw = pd.read_csv(RAW_PATH)
    print(f"Loaded {len(raw)} raw rows across {raw['train_number'].nunique()} trains")

    features = build_features(raw)
    print(f"Kept {len(features)} rows after cleaning")
    print(features["train_category"].value_counts())

    features.to_csv(OUT_PATH, index=False)
    print(f"Saved features to {OUT_PATH}")
