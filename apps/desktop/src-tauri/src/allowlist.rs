pub const ALLOWED_METHODS: [&str; 17] = [
    "project.open",
    "project.list",
    "project.status",
    "audit.plan",
    "audit.run",
    "audit.cancel",
    "audit.history",
    "finding.list",
    "finding.detail",
    "finding.suppress",
    "agent.chat",
    "agent.cancel",
    "tools.list",
    "tools.install",
    "tools.remove",
    "models.list",
    "models.configure",
];

pub fn is_allowed(method: &str) -> bool {
    ALLOWED_METHODS.contains(&method)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_the_project_methods() {
        for m in ["project.open", "project.list", "project.status"] {
            assert!(is_allowed(m), "{m}");
        }
    }

    #[test]
    fn rejects_shell_exec_and_lookalikes() {
        for m in [
            "shell.exec",
            "shell",
            "",
            "PROJECT.OPEN",
            "project.open ",
            " project.open",
            "project",
            "project.open\n",
            "fs.read",
        ] {
            assert!(!is_allowed(m), "{m:?}");
        }
    }

    #[test]
    fn has_no_duplicates_and_no_shell_methods() {
        let mut seen = std::collections::HashSet::new();
        for m in ALLOWED_METHODS {
            assert!(seen.insert(m), "duplicate {m}");
            assert!(!m.starts_with("shell"), "{m}");
        }
        assert_eq!(seen.len(), 17);
    }
}
