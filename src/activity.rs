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
}

impl fmt::Display for ActivityStateValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let value = match self {
            Self::Working => "working",
            Self::Idle => "idle",
            Self::Waiting => "waiting",
            Self::Blocked => "blocked",
            Self::Stopped => "stopped",
        };
        formatter.write_str(value)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ActivityState {
    pub value: ActivityStateValue,
    pub updated_at: DateTime<Utc>,
}
