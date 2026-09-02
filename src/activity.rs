use std::fmt;

use chrono::{DateTime, Utc};
use clap::ValueEnum;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum ActivityStateValue {
    Working,
    Idle,
    Waiting,
    Blocked,
    Stopped,
    Unknown,
}

impl ActivityStateValue {
    pub fn from_external(value: &str) -> Self {
        match value {
            "working" => Self::Working,
            "idle" => Self::Idle,
            "waiting" => Self::Waiting,
            "blocked" => Self::Blocked,
            "stopped" => Self::Stopped,
            _ => Self::Unknown,
        }
    }
}

impl fmt::Display for ActivityStateValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Working => "working",
            Self::Idle => "idle",
            Self::Waiting => "waiting",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
            Self::Unknown => "unknown",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityState {
    pub value: ActivityStateValue,
    pub updated_at: DateTime<Utc>,
}

impl ActivityState {
    pub fn unknown(updated_at: DateTime<Utc>) -> Self {
        Self {
            value: ActivityStateValue::Unknown,
            updated_at,
        }
    }

    pub fn from_external(value: &str, updated_at: DateTime<Utc>) -> Self {
        Self {
            value: ActivityStateValue::from_external(value),
            updated_at,
        }
    }
}
