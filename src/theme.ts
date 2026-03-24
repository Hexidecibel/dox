import { createTheme } from '@mui/material/styles';

export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1a365d',
      light: '#2a4a7f',
      dark: '#0f2341',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#4a6fa5',
      light: '#6b8fc0',
      dark: '#345080',
      contrastText: '#ffffff',
    },
    background: {
      default: '#f7f8fa',
      paper: '#ffffff',
    },
    text: {
      primary: '#1a1a2e',
      secondary: '#5a6474',
    },
    error: {
      main: '#c53030',
    },
    success: {
      main: '#2f855a',
    },
    warning: {
      main: '#c05621',
    },
    info: {
      main: '#2b6cb0',
    },
    divider: '#e2e8f0',
    action: {
      hover: 'rgba(26, 54, 93, 0.04)',
      selected: 'rgba(26, 54, 93, 0.08)',
    },
  },
  typography: {
    fontFamily: "'Inter', 'Segoe UI', 'Roboto', sans-serif",
    h1: {
      fontSize: '2.25rem',
      fontWeight: 600,
      color: '#1a365d',
      letterSpacing: '-0.01em',
      lineHeight: 1.3,
    },
    h2: {
      fontSize: '1.875rem',
      fontWeight: 600,
      color: '#1a365d',
      letterSpacing: '-0.01em',
      lineHeight: 1.3,
    },
    h3: {
      fontSize: '1.5rem',
      fontWeight: 600,
      color: '#1a365d',
      lineHeight: 1.4,
    },
    h4: {
      fontSize: '1.375rem',
      fontWeight: 600,
      color: '#1a365d',
      lineHeight: 1.4,
    },
    h5: {
      fontSize: '1.125rem',
      fontWeight: 600,
      color: '#1a365d',
      lineHeight: 1.4,
    },
    h6: {
      fontSize: '1rem',
      fontWeight: 600,
      color: '#1a365d',
      lineHeight: 1.5,
    },
    body1: {
      fontSize: '0.9375rem',
      lineHeight: 1.6,
    },
    body2: {
      fontSize: '0.875rem',
      lineHeight: 1.5,
    },
    caption: {
      fontSize: '0.75rem',
      lineHeight: 1.5,
    },
    overline: {
      fontSize: '0.6875rem',
      fontWeight: 600,
      letterSpacing: '0.08em',
      lineHeight: 1.5,
    },
  },
  shape: {
    borderRadius: 6,
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
          fontWeight: 500,
          borderRadius: 5,
          boxShadow: 'none',
          '&:hover': {
            boxShadow: 'none',
          },
        },
        contained: {
          '&:hover': {
            boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
          },
        },
        outlined: {
          borderColor: '#d1d9e6',
        },
      },
      defaultProps: {
        disableElevation: true,
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
          border: '1px solid #e2e8f0',
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
        outlined: {
          borderColor: '#e2e8f0',
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          fontWeight: 500,
          fontSize: '0.75rem',
        },
      },
      defaultProps: {
        variant: 'outlined',
      },
    },
    MuiTableHead: {
      styleOverrides: {
        root: {
          '& .MuiTableCell-root': {
            backgroundColor: '#f7f8fa',
            fontWeight: 600,
            fontSize: '0.8125rem',
            color: '#1a365d',
            borderBottom: '2px solid #e2e8f0',
            whiteSpace: 'nowrap',
          },
        },
      },
    },
    MuiTableBody: {
      styleOverrides: {
        root: {
          '& .MuiTableRow-root:nth-of-type(even)': {
            backgroundColor: '#fafbfc',
          },
        },
      },
    },
    MuiTableCell: {
      styleOverrides: {
        root: {
          borderBottom: '1px solid #edf0f4',
          fontSize: '0.875rem',
          padding: '10px 16px',
        },
      },
    },
    MuiAppBar: {
      styleOverrides: {
        root: {
          backgroundColor: '#ffffff',
          color: '#1a365d',
        },
      },
      defaultProps: {
        elevation: 0,
      },
    },
    MuiDrawer: {
      styleOverrides: {
        paper: {
          backgroundColor: '#f7f8fa',
          borderRight: '1px solid #e2e8f0',
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            '& fieldset': {
              borderColor: '#d1d9e6',
            },
          },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          border: '1px solid #e2e8f0',
          boxShadow: '0 4px 24px rgba(0,0,0,0.1)',
        },
      },
    },
    MuiAlert: {
      styleOverrides: {
        root: {
          borderRadius: 6,
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: {
          borderColor: '#e2e8f0',
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: 5,
          '&.Mui-selected': {
            backgroundColor: 'rgba(26, 54, 93, 0.08)',
            '&:hover': {
              backgroundColor: 'rgba(26, 54, 93, 0.12)',
            },
          },
        },
      },
    },
    MuiCssBaseline: {
      styleOverrides: {
        body: {
          backgroundColor: '#f7f8fa',
        },
      },
    },
  },
});
