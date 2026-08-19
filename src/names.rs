const FIRST_NAME_DATA: &str = concat!(
    include_str!("../data/names/fungi.txt"),
    include_str!("../data/names/herbs.txt"),
    include_str!("../data/names/knots.txt"),
    include_str!("../data/names/nature.txt"),
    include_str!("../data/names/stars.txt"),
    include_str!("../data/names/winds.txt"),
);

const FAMILY_NAME_DATA: &str = concat!(
    include_str!("../data/names/shipping.txt"),
    include_str!("../data/names/trades.txt"),
);

pub fn first_names() -> Vec<&'static str> {
    unique_words(FIRST_NAME_DATA)
}

pub fn family_names() -> Vec<&'static str> {
    unique_words(FAMILY_NAME_DATA)
}

fn unique_words(data: &'static str) -> Vec<&'static str> {
    let mut words = Vec::new();
    for word in data.lines().map(str::trim).filter(|word| !word.is_empty()) {
        if !words.contains(&word) {
            words.push(word);
        }
    }
    words
}
