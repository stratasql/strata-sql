USE [Clinic]
GO
/****** Object:  Table [dbo].[Patient]    Script Date: 01/03/2024 10:00:00 ******/
SET ANSI_NULLS ON
GO
SET QUOTED_IDENTIFIER ON
GO
CREATE TABLE [dbo].[Patient](
	[PatientId] [int] IDENTITY(1,1) NOT NULL,
	[FullName] [nvarchar](200) NOT NULL,
	[BirthDate] [date] NULL,
	[Active] [bit] NOT NULL,
	[Notes] [nvarchar](max) NULL,
 CONSTRAINT [PK_Patient] PRIMARY KEY CLUSTERED
(
	[PatientId] ASC
)WITH (PAD_INDEX = OFF, STATISTICS_NORECOMPUTE = OFF, IGNORE_DUP_KEY = OFF, ALLOW_ROW_LOCKS = ON, ALLOW_PAGE_LOCKS = ON) ON [PRIMARY]
) ON [PRIMARY] TEXTIMAGE_ON [PRIMARY]
GO
CREATE TABLE [dbo].[Doctor](
	[DoctorId] [int] NOT NULL,
	[Name] [nvarchar](100) NOT NULL,
	[Specialty] [nvarchar](60) NULL,
 CONSTRAINT [PK_Doctor] PRIMARY KEY CLUSTERED ([DoctorId] ASC) ON [PRIMARY]
) ON [PRIMARY]
GO
CREATE TABLE [dbo].[Visit](
	[VisitId] [int] IDENTITY(1,1) NOT NULL,
	[PatientId] [int] NOT NULL,
	[DoctorId] [int] NOT NULL,
	[VisitedAt] [datetime2](7) NOT NULL,
	[Fee] [money] NULL,
	[FeeWithTax]  AS ([Fee]*(1.2)),
 CONSTRAINT [PK_Visit] PRIMARY KEY CLUSTERED ([VisitId] ASC) ON [PRIMARY]
) ON [PRIMARY]
GO
ALTER TABLE [dbo].[Patient] ADD  CONSTRAINT [DF_Patient_Active]  DEFAULT ((1)) FOR [Active]
GO
ALTER TABLE [dbo].[Visit] ADD  CONSTRAINT [DF_Visit_VisitedAt]  DEFAULT (getdate()) FOR [VisitedAt]
GO
ALTER TABLE [dbo].[Visit]  WITH CHECK ADD  CONSTRAINT [FK_Visit_Patient] FOREIGN KEY([PatientId])
REFERENCES [dbo].[Patient] ([PatientId])
GO
ALTER TABLE [dbo].[Visit] CHECK CONSTRAINT [FK_Visit_Patient]
GO
ALTER TABLE [dbo].[Visit]  WITH NOCHECK ADD  CONSTRAINT [FK_Visit_Doctor] FOREIGN KEY([DoctorId])
REFERENCES [dbo].[Doctor] ([DoctorId])
ON DELETE CASCADE
GO
CREATE NONCLUSTERED INDEX [IX_Visit_Patient] ON [dbo].[Visit]
(
	[PatientId] ASC
)WITH (PAD_INDEX = OFF) ON [PRIMARY]
GO
CREATE UNIQUE NONCLUSTERED INDEX [UX_Doctor_Name] ON [dbo].[Doctor] ([Name] ASC)
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'A person who is treated here' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Patient'
GO
EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'Legal name, as on the insurance card' , @level0type=N'SCHEMA',@level0name=N'dbo', @level1type=N'TABLE',@level1name=N'Patient', @level2type=N'COLUMN',@level2name=N'FullName'
GO
CREATE VIEW [dbo].[VisitsPerDoctor]
AS
SELECT d.Name, COUNT(*) AS VisitCount, SUM(v.Fee) AS TotalFees
FROM dbo.Visit AS v
INNER JOIN dbo.Doctor AS d ON d.DoctorId = v.DoctorId
GROUP BY d.Name
GO
CREATE PROCEDURE [dbo].[usp_AddVisit]
    @PatientId int, @DoctorId int
AS
BEGIN
    SET NOCOUNT ON;
    INSERT INTO dbo.Visit (PatientId, DoctorId) VALUES (@PatientId, @DoctorId);
    IF @@ROWCOUNT = 0
    BEGIN
        RAISERROR('nothing', 16, 1);
    END
END
GO
CREATE TRIGGER [dbo].[trg_Patient_Audit] ON [dbo].[Patient] AFTER UPDATE AS BEGIN SET NOCOUNT ON; UPDATE dbo.Patient SET Notes = 'x' WHERE 1 = 0; END
GO
